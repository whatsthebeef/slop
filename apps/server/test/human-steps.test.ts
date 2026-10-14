import { humanSteps } from '@slop/core';
import type { Glob, StoredHumanStep } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { globViewFor } from '../src/http/views.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const AT = '2026-10-05T12:00:00.000Z';

const glob = (id: string, boardId: number): Glob => ({
  id,
  boardId,
  title: id,
  type: 'same',
  category: 'feature',
  group: null,
  environment: null,
  status: 'pr_open',
  version: 1,
  generation: 1,
  creator: DEV,
  planner: DEV,
  implementer: DEV,
  labels: {},
  checklists: {},
  pr: { number: 1, state: 'ready', headSha: `${id}-head` },
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: AT,
  updatedAt: AT,
  signedOffAt: null,
  doingSince: AT,
});

const step = (id: string, globId: string, boardId: number, patch: Partial<StoredHumanStep> = {}): StoredHumanStep => ({
  id,
  boardId,
  globId,
  kind: 'rollout',
  title: `Step ${id}`,
  detail: 'Run it\n\nthen check',
  who: 'admin',
  due: 'after_merge',
  state: 'open',
  blocks: ['sign_off', 'dependants'],
  check: 'fileAttachments',
  script: { path: 'infra/deploy/host-deploy.sh' },
  origin: 'rollout-section',
  createdBy: DEV,
  createdAt: AT,
  doneBy: null,
  doneAt: null,
  dismissedReason: null,
  ...patch,
});

describe('human steps in Postgres', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;

  beforeAll(async () => {
    const test = await createTestDatabase('human_steps');
    drop = test.drop;
    store = new PgStore(test.database.db);
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
      for (const id of ['s9f1', 's9f2']) await tx.insertGlob(glob(id, board.id), null);
      return board.id;
    });
  });

  afterAll(async () => {
    await drop();
  });

  it('round-trips work steps, with their scripts, blocks and who ticked them', async () => {
    const open = step('hs-open', 's9f1', boardId);
    const done = step('hs-done', 's9f1', boardId, { state: 'done', doneBy: DEV, doneAt: '2026-10-06T08:00:00.000Z', script: null, check: null, detail: null });
    await store.transaction((tx) => tx.saveHumanSteps([open, done]));
    expect(await store.transaction((tx) => tx.listHumanSteps(boardId, ['s9f1']))).toEqual([done, open]);
    expect(await store.transaction((tx) => tx.listHumanSteps(boardId, []))).toEqual([]);
    expect(await store.transaction((tx) => tx.listHumanSteps(boardId, ['s9f2']))).toEqual([]);
  });

  it('saving again replaces the step; the board list reads open steps only', async () => {
    const ticked = step('hs-open', 's9f1', boardId, { state: 'done', doneBy: DEV, doneAt: AT });
    const another = step('hs-2', 's9f2', boardId, { due: 'now', blocks: [] });
    await store.transaction((tx) => tx.saveHumanSteps([ticked, another]));
    const stored = await store.transaction((tx) => tx.listHumanSteps(boardId, ['s9f1']));
    expect(stored.find((s) => s.id === 'hs-open')).toMatchObject({ state: 'done', doneBy: DEV });
    expect((await store.transaction((tx) => tx.listOpenHumanSteps(boardId))).map((s) => s.id)).toEqual(['hs-2']);
  });

  it('reads one glob with its derived and stored steps, and the list view carries the compact form', async () => {
    const g = await store.transaction((tx) => tx.getGlob('s9f2'));
    expect(g).not.toBeNull();
    if (g === null) return;
    const open = await store.transaction((tx) => tx.listOpenHumanSteps(boardId));
    const view = globViewFor(g, DEV, 'dev', [], undefined, [], false, open.filter((s) => s.globId === g.id));
    expect(view.humanSteps).toEqual([
      { id: 'hs-2', kind: 'rollout', title: 'Step hs-2', state: 'due', who: 'admin', due: 'now', blocks: [] },
    ]);
    expect(humanSteps(g, {}, open).map((s) => s.id)).toEqual(['hs-2']);
  });

  it('deleting a glob deletes its steps', async () => {
    await store.transaction((tx) => tx.deleteGlob('s9f2'));
    expect(await store.transaction((tx) => tx.listHumanSteps(boardId, ['s9f2']))).toEqual([]);
  });
});
