import type { SizeCheck } from '@slop/core';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { compactKbItem, compactSizeProposal } from '../src/http/views.js';
import { RequestMetrics, requestTiming } from '../src/request-metrics.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const appWith = (options: { slowMs?: number; timeoutMs?: number }) => {
  const metrics = new RequestMetrics();
  const lines: Record<string, unknown>[] = [];
  const app = new Hono();
  app.use('*', requestTiming({ metrics, log: (line) => lines.push(JSON.parse(line) as Record<string, unknown>), ...options }));
  app.get('/api/things/:id', async (c) => {
    await metrics.db(() => sleep(30));
    await metrics.llm(() => sleep(20));
    return c.json({ id: c.req.param('id'), pad: 'x'.repeat(500) });
  });
  app.get('/api/stuck', async (c) => {
    await sleep(500);
    return c.json({});
  });
  app.get('/api/boom', () => {
    throw new Error('boom');
  });
  return { app, metrics, lines };
};

describe('request timing', () => {
  it('logs a slow request with its route, status, database and model time and response size', async () => {
    const { app, lines } = appWith({ slowMs: 10 });
    const res = await app.request('/api/things/42?token=secret');
    expect(res.status).toBe(200);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? {};
    expect(line).toMatchObject({ slowRequest: true, route: 'GET /api/things/:id', method: 'GET', path: '/api/things/:n', status: 200, timedOut: false });
    expect(line.dbMs as number).toBeGreaterThanOrEqual(25);
    expect(line.llmMs as number).toBeGreaterThanOrEqual(15);
    expect(line.bytes as number).toBeGreaterThan(500);
    expect(JSON.stringify(line)).not.toContain('secret');
  });

  it('logs nothing for a fast request but still counts it', async () => {
    const { app, lines, metrics } = appWith({ slowMs: 5_000 });
    await app.request('/api/things/1');
    expect(lines).toEqual([]);
    expect(metrics.summary().routes.map((r) => [r.route, r.count])).toEqual([['GET /api/things/:id', 1]]);
  });

  it('answers 503 with a reason when a request outlives the timeout, and the late failure is not unhandled', async () => {
    const { app, lines } = appWith({ timeoutMs: 50 });
    const started = Date.now();
    const res = await app.request('/api/stuck');
    expect(Date.now() - started).toBeLessThan(400);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'timeout' });
    expect(lines[0]).toMatchObject({ timedOut: true, status: 503 });
    await sleep(500);
  });

  it('gives every path no route matched one label, and logs none of its text', async () => {
    const { app, lines, metrics } = appWith({ slowMs: 0 });
    await app.request('/zzz-random-1');
    await app.request('/zzz-random-2');
    expect(metrics.summary().routes.map((r) => r.route)).toEqual(['GET <unmatched>']);
    expect(JSON.stringify(lines)).not.toContain('zzz-random');
  });

  it('does not time out or record an event stream', async () => {
    const metrics = new RequestMetrics();
    const app = new Hono();
    app.use('*', requestTiming({ metrics, timeoutMs: 20 }));
    app.get('/events', async (c) => {
      await sleep(80);
      return c.text('ok');
    });
    const res = await app.request('/events', { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    expect(metrics.summary().routes).toEqual([]);
  });

  it('brings the database and model gauges back to zero after a failure', async () => {
    const metrics = new RequestMetrics();
    await expect(metrics.db(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(metrics.llm(() => Promise.reject(new Error('y')))).rejects.toThrow('y');
    expect(metrics.summary()).toMatchObject({ dbTransactionsOpen: 0, llmCallsInFlight: 0 });
  });

  it('summarises p50/p95/p99 per route and the load', () => {
    const metrics = new RequestMetrics();
    for (let ms = 1; ms <= 100; ms++) metrics.record('GET /a', ms, ms === 100 ? 500 : 200);
    metrics.record('mcp get_glob', 3, 200);
    const summary = metrics.summary();
    expect(summary.routes[0]).toMatchObject({ route: 'GET /a', count: 100, errors: 1, p50Ms: 51, p95Ms: 96, p99Ms: 100, maxMs: 100 });
    expect(summary.routes[1]?.route).toBe('mcp get_glob');
    expect(summary).toMatchObject({ inFlightRequests: 0, dbTransactionsOpen: 0, llmCallsInFlight: 0 });
  });

  it('forgets samples older than the window', () => {
    let now = 0;
    const metrics = new RequestMetrics(() => now);
    metrics.record('GET /old', 5, 200);
    now = 61 * 60_000;
    expect(metrics.summary().routes).toEqual([]);
  });
});

describe('compacting reads for MCP', () => {
  const plan = 'Plan text. '.repeat(1_000);
  const sizeCheck = {
    proposal: { parts: [{ title: 'One', plan, after: [] }, { title: 'Two', plan, after: [0] }], criticalPath: 2, maxParallel: 1 },
  } as unknown as SizeCheck;

  it('replaces each proposed part’s plan with a short summary and its length', () => {
    const view = compactSizeProposal({ id: 'x', sizeCheck });
    const parts = view.sizeCheck.proposal?.parts as unknown as Record<string, unknown>[];
    expect(parts[0]).toMatchObject({ title: 'One', after: [], planChars: plan.length });
    expect(parts[0]).not.toHaveProperty('plan');
    expect(JSON.stringify(view).length).toBeLessThan(15_000);
    expect(JSON.stringify({ sizeCheck }).length).toBeGreaterThan(20_000);
  });

  it('leaves a view without a proposal as it was', () => {
    const view = { sizeCheck: null };
    expect(compactSizeProposal(view)).toBe(view);
  });

  it('clips a KB item’s long text, counts the extra evidence and drops the preview', () => {
    const item = compactKbItem({
      id: 's15k1',
      statement: 'S',
      evidence: 'e'.repeat(5_000),
      extraEvidence: [{ evidence: 'e'.repeat(5_000) }, { evidence: 'f' }],
      draft: { section: 'Notes', content: 'd'.repeat(5_000) },
      preview: { version: 1, stale: false, diff: new Array(500).fill({ text: 'line' }), duplicateSections: [] },
      document: null,
    });
    expect(JSON.stringify(item).length).toBeLessThan(2_000);
    expect(item).toMatchObject({ id: 's15k1', evidenceChars: 5_000, extraEvidenceCount: 2, draft: { section: 'Notes', contentChars: 5_000 }, document: null });
    expect(item).not.toHaveProperty('preview');
    expect(item).not.toHaveProperty('extraEvidence');
  });
});
