import type { Effect, GlobService } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { llmWaitingReason } from '@slop/core';
import { kbExecutors, PROBE_MS, PROBE_WAIT_REASON } from '../src/kb-executors.js';

const deps = { globs: {} as GlobService };
const route: Effect = { kind: 'kb_route', globId: 's1k1' };
const draft: Effect = { kind: 'kb_draft', globId: 's1k2' };

/** A pipeline that records each step it runs; a step can flip the models' health, as a real call would. */
const pipeline = (onStep: () => void = () => undefined) => {
  const steps: string[] = [];
  return {
    steps,
    runStep: (itemId: string, step: 'route' | 'draft') => {
      steps.push(`${step} ${itemId}`);
      onStep();
      return Promise.resolve('done' as const);
    },
  };
};

describe('KB executors', () => {
  it('runs each job\'s step while the models are up', async () => {
    const p = pipeline();
    const executors = kbExecutors(p, { isDown: () => false });
    expect(await executors.kb_route?.(route, null, deps)).toBe('done');
    expect(await executors.kb_draft?.(draft, null, deps)).toBe('done');
    expect(p.steps).toEqual(['route s1k1', 'draft s1k2']);
  });

  it('while the models are down, lets one job a minute call them and makes the rest wait without an attempt', async () => {
    let now = 1_000_000;
    let down = true;
    let recovers = false;
    const p = pipeline(() => {
      if (recovers) down = false;
    });
    const executors = kbExecutors(p, { isDown: () => down }, () => now);
    // The first job is the probe; its call finds them down again.
    expect(await executors.kb_route?.(route, null, deps)).toBe('done');
    expect(p.steps).toHaveLength(1);
    // Jobs within the minute wait for the rest of it, with the waiting reason the Knowledge page shows.
    now += 10_000;
    const waiting = await executors.kb_draft?.(draft, null, deps);
    expect(waiting).toEqual({ state: 'pending', retryAfterMs: PROBE_MS - 10_000, reason: PROBE_WAIT_REASON });
    // An item whose last attempt failed reads as waiting for the AI, not as retrying now.
    const reason = typeof waiting === 'object' ? (waiting.reason ?? null) : null;
    expect(llmWaitingReason({ processing: 'routed', processingError: reason })).toBe('the KB models are down; trying again once a probe gets through');
    expect(p.steps).toHaveLength(1);
    // A minute after the last call, the next probe.
    now += PROBE_MS - 10_000;
    expect(await executors.kb_draft?.(draft, null, deps)).toBe('done');
    expect(p.steps).toHaveLength(2);
    // A probe whose call works marks them up: jobs run back to back again.
    now += PROBE_MS;
    recovers = true;
    await executors.kb_route?.(route, null, deps);
    expect(down).toBe(false);
    await executors.kb_route?.(route, null, deps);
    await executors.kb_draft?.(draft, null, deps);
    expect(p.steps).toHaveLength(5);
  });

  it('counts a call that threw as a probe, so a failing store cannot make a call on every job', async () => {
    let now = 1_000_000;
    const failing = { runStep: () => Promise.reject(new Error('connection lost')) };
    const executors = kbExecutors(failing, { isDown: () => true }, () => now);
    await expect(executors.kb_route?.(route, null, deps)).rejects.toThrow('connection lost');
    now += 1;
    expect(await executors.kb_route?.(route, null, deps)).toMatchObject({ state: 'pending' });
  });
});
