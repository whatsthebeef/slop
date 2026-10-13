import { readFile } from 'node:fs/promises';
import type { Glob } from '@slop/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';

const glob = (id: string, boardId: number): Glob => ({
  id,
  boardId,
  title: id,
  type: 'same',
  category: 'feature',
  group: null,
  environment: null,
  status: 'signed_off',
  version: 1,
  generation: 1,
  creator: DEV,
  planner: DEV,
  implementer: null,
  labels: {},
  checklists: {},
  pr: { number: 269, state: 'merged', headSha: 'head' },
  prs: [],
  mergeMode: null,
  headChecks: null,
  updatedAt: '2026-10-13T14:14:43.758Z',
  signedOffAt: '2026-10-13T14:14:43.758Z',
  createdAt: '2026-10-13T13:15:36.789Z',
  doingSince: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
});

describe('0064 backfill of s15f78 rollout steps', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let run: () => Promise<void>;
  let boardId: number;

  beforeAll(async () => {
    const test = await createTestDatabase('backfill_f78');
    drop = test.drop;
    store = new PgStore(test.database.db);
    const migration = await readFile(new URL('../drizzle/0064_backfill_s15f78_rollout.sql', import.meta.url), 'utf8');
    run = async () => {
      await test.database.db.execute(sql.raw(migration));
    };
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const board = await tx.insertBoard({
        name: 'sandbox',
        repo: 'acme/sandbox',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
  });

  afterAll(async () => {
    await drop();
  });

  const steps = () => store.transaction((tx) => tx.listHumanSteps(boardId, ['s15f78']));

  it('does nothing where s15f78 does not exist', async () => {
    await run();
    expect(await steps()).toEqual([]);
  });

  it('gives s15f78 its rollout steps, once, leaving the glob signed off and any ticked step as it is', async () => {
    await store.transaction((tx) => tx.insertGlob(glob('s15f78', boardId), null));
    await run();
    const first = await steps();
    expect(first).toHaveLength(5);
    expect(first.every((s) => s.kind === 'rollout' && s.state === 'open' && s.due === 'after_merge' && s.blocks.join() === 'dependants')).toBe(true);
    expect(first.filter((s) => s.script !== null && 'artifact' in s.script && s.script.artifact === 'Rollout script')).toHaveLength(3);
    expect(first.some((s) => s.check === 'fileAttachments')).toBe(true);

    const [one] = first;
    if (one === undefined) throw new Error('no steps');
    await store.transaction((tx) => tx.saveHumanSteps([{ ...one, state: 'done', doneBy: DEV, doneAt: '2026-10-14T08:00:00.000Z' }]));
    await run();
    const second = await steps();
    expect(second).toHaveLength(5);
    expect(second.find((s) => s.id === one.id)?.state).toBe('done');
    expect((await store.transaction((tx) => tx.getGlob('s15f78')))?.status).toBe('signed_off');
  });
});
