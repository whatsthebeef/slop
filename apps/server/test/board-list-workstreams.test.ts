import { ArtifactService, BoardService, GlobService, GroupService } from '@slop/core';
import type { Result, WorkstreamsSummary } from '@slop/core';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import type { Env } from '../src/http/app.js';
import { OutboxRunner } from '../src/jobs/outbox.js';
import { HintHub } from '../src/notifier.js';
import { SignedLinks } from '../src/signed-links.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const WS = (name: string, state: string, conflicts: string[] = []) => ({
  name,
  goal: `${name} goal`,
  predictedFiles: ['a.ts'],
  actualFiles: [],
  needs: [],
  state,
  attempts: 1,
  conflicts,
  durationMinutes: null,
});
const record = (block: unknown): string => `# Implementation record\n## Workstreams\n\n\`\`\`workstreams\n${JSON.stringify(block)}\n\`\`\`\n`;

interface Listed {
  id: string;
  workstreams?: WorkstreamsSummary;
  machineSteps?: unknown[];
}

describe('the board list carries the workstreams of a fanned-out glob (Postgres)', () => {
  let drop: () => Promise<void>;
  let database: Database;
  let app: Hono<Env>;
  let artifacts: ArtifactService;
  let globs: GlobService;
  let boardId: number;

  const make = async (title: string): Promise<string> =>
    unwrap(await globs.create(ADMIN, { boardId, title, type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: title })).id;
  const put = async (id: string, content: string, commitSha: string) => {
    unwrap(await artifacts.putArtifact(ADMIN, id, 'implementation_plan', content, { commitSha, runId: null, agentSetVersion: null }));
  };
  const get = async <T>(path: string): Promise<T> => {
    const res = await app.request(path, { headers: { authorization: `Bearer dev:${ADMIN}` } });
    expect(res.status).toBe(200);
    // The route's JSON is read by shape in this test, not validated.
    return (await res.json()) as T;
  };

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('board_list_workstreams'));
    const store = new PgStore(database.db);
    const notifier = new HintHub();
    const clock = { now: () => new Date().toISOString() };
    const deps = { store, notifier, clock };
    globs = new GlobService({ ...deps, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(true) } });
    artifacts = new ArtifactService(deps);
    const boards = new BoardService(deps);
    const groups = new GroupService({ store, globs, boards, clock });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    const outbox = new OutboxRunner(database.db, { globs }, {}, () => undefined);
    app = createApp({ auth: new Auth(database.db, loadConfig({})), links: new SignedLinks('test'), boards, globs, groups, hub: notifier, outbox, onBoardCreated: () => Promise.resolve() });
  });

  afterAll(async () => {
    await drop();
  });

  it('has the newest block for a fanned-out glob, and no field for a small glob or one that was not fanned out', async () => {
    const big = await make('Big');
    const small = await make('Small');
    const plain = await make('Plain');
    await put(big, record({ fannedOut: true, maxParallel: 2, workstreams: [WS('W0', 'done'), WS('W1', 'running')] }), 'one');
    await put(big, record({ fannedOut: true, maxParallel: 2, workstreams: [WS('W0', 'done'), WS('W1', 'failed')] }), 'two');
    await put(small, record({ fannedOut: false, maxParallel: 1, workstreams: [] }), 'one');
    await put(plain, '# Implementation record\nNo workstreams here', 'one');

    const list = await get<Listed[]>(`/api/boards/${boardId}/globs`);
    expect(list.find((g) => g.id === big)?.workstreams).toEqual({
      fannedOut: true,
      items: [
        { name: 'W0', state: 'done', conflicts: [] },
        { name: 'W1', state: 'failed', conflicts: [] },
      ],
    });
    expect(list.find((g) => g.id === small)).not.toHaveProperty('workstreams');
    expect(list.find((g) => g.id === plain)).not.toHaveProperty('workstreams');

    const single = await get<Listed>(`/api/globs/${big}`);
    expect(single.workstreams?.items.map((i) => i.state)).toEqual(['done', 'failed']);
    // The glob read carries the machine steps the list does, so the header and the card say the same.
    expect(Array.isArray(single.machineSteps)).toBe(true);
    expect(await get<Listed>(`/api/globs/${plain}`)).not.toHaveProperty('workstreams');
  });
});
