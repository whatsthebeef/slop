import { GlobService } from '@slop/core';
import type { Result, SizeCheck } from '@slop/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { buildServer } from '../src/mcp/server.js';
import type { McpDeps } from '../src/mcp/server.js';
import { createTestDatabase } from './support/database.js';

/** `get_glob` over MCP: the size check's workstreams carry a short summary of each plan share, whether or not the flag was answered; the flag never holds the glob. */

const DEV = 'dev@example.com';
const NOW = '2026-10-14T12:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

interface Workstream {
  name: string;
  goal: string;
  files: string[];
  needs: number[];
  plan?: string;
  planSummary?: string;
  planChars?: number;
}
interface GlobBody {
  oversized?: boolean;
  allowedActions: string[];
  sizeCheck: { reasons: string[]; decision: string | null; proposal: { criticalPath: number; workstreams: Workstream[] } };
}

const PLAN_A = `## Tasks\n1. ${'migration and a long description of it. '.repeat(250)}\nDone when: it works.`;
const PLAN_B = `## Tasks\n2.   spaced\n\n   out   plan\n${'web card. '.repeat(400)}`;

describe('get_glob with a size-check proposal', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let client: Client;
  let globId: string;
  let heldId: string;

  const call = async (args: Record<string, unknown>): Promise<{ text: string; body: GlobBody }> => {
    const result = await client.callTool({ name: 'get_glob', arguments: args });
    const [first] = result.content as { text: string }[];
    const text = first?.text ?? 'null';
    return { text, body: JSON.parse(text) as GlobBody };
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('get_glob_size'));
    store = new PgStore(database.db);
    const deps = { store, notifier: { publish: () => undefined }, clock: { now: () => NOW } };
    const globs = new GlobService({ ...deps, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) } });
    const boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({ name: 'size', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'admin' });
      return board.id;
    });
    const make = async (title: string) =>
      unwrap(await globs.create(DEV, { boardId, title, plan: PLAN_A, type: 'same', category: 'feature', group: null, environment: null, autoTrigger: false, idempotencyKey: null })).id;
    globId = await make('Answered');
    heldId = await make('Held');
    const checkOf = (id: string, decision: SizeCheck['decision']): SizeCheck => ({
      globId: id,
      boardId,
      planHash: 'h',
      estimate: { tasks: 6, doneWhenLines: 1, areas: [], untaskedSections: 0, independentParts: 4, partsSource: 'model', parallelParts: 3, reasoning: 'four' },
      evidence: ['e'],
      threshold: { maxTasks: 5, maxParts: 3 },
      flagged: true,
      reasons: ['6 tasks'],
      proposal: {
        criticalPath: 2,
        maxParallel: 1,
        workstreams: [
          { name: 'Data', goal: 'the table', files: ['apps/server/drizzle/1.sql'], plan: PLAN_A, needs: [] },
          { name: 'Web', goal: 'the card', files: [], plan: PLAN_B, needs: [0] },
        ],
      },
      decision,
      decidedBy: decision === null ? null : DEV,
      decidedAt: decision === null ? null : NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await store.transaction(async (tx) => {
      await tx.upsertSizeCheck(checkOf(globId, 'split'));
      await tx.upsertSizeCheck(checkOf(heldId, null));
    });
    const deploys = { history: () => Promise.resolve({ ok: true, value: [] }) };
    const server = buildServer({ globs, deploys } as unknown as McpDeps, DEV, 'http://localhost');
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    await drop();
  });

  it('summarises each workstream plan share, keeping its name, goal, files, needs and plan length', async () => {
    const { body } = await call({ id: globId });
    const [data, web] = body.sizeCheck.proposal.workstreams;
    expect(data).toEqual({
      name: 'Data',
      goal: 'the table',
      files: ['apps/server/drizzle/1.sql'],
      needs: [],
      planSummary: PLAN_A.replace(/\s+/g, ' ').slice(0, 200),
      planChars: PLAN_A.length,
    });
    expect(web?.plan).toBeUndefined();
    expect(web?.planSummary).toHaveLength(200);
    expect(web?.planSummary).not.toMatch(/\s{2}/);
    expect(web).toMatchObject({ name: 'Web', needs: [0], planChars: PLAN_B.length });
    expect(body.sizeCheck).toMatchObject({ reasons: ['6 tasks'], decision: 'split' });
    expect(body.sizeCheck.proposal.criticalPath).toBe(2);
  });

  it('is just as compact for a glob whose flag nobody answered: it is not held, and the plans are not sent', async () => {
    const { body, text } = await call({ id: heldId });
    expect(body.oversized).toBe(true);
    expect(body.allowedActions).toContain('start');
    expect(body.sizeCheck.proposal.workstreams.map((w) => w.plan)).toEqual([undefined, undefined]);
    expect(text.length).toBeLessThan((PLAN_A.length + PLAN_B.length) / 2);
  });

  it("no longer takes include: ['size_proposal']", async () => {
    const result = await client.callTool({ name: 'get_glob', arguments: { id: globId, include: ['size_proposal'] } });
    const [first] = result.content as { text: string }[];
    const body = JSON.parse(first?.text ?? 'null') as GlobBody;
    expect(body.sizeCheck.proposal.workstreams.every((w) => w.plan === undefined)).toBe(true);
  });
});
