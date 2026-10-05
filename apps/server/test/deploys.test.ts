import { DeployService } from '@slop/core';
import type { Board, Glob, Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const DEV = 'dev@example.com';

const glob = (id: string, boardId: number): Glob => ({
  id,
  boardId,
  title: id,
  summary: '',
  type: 'super',
  category: 'feature',
  group: null,
  environment: 'dev1',
  status: 'in_progress',
  version: 1,
  generation: 1,
  creator: DEV,
  planner: DEV,
  implementer: DEV,
  labels: {},
  checklists: {},
  pr: { number: 1, state: 'draft', headSha: `${id}-head` },
  prs: [],
  mergeMode: null,
  headChecks: null,
  runs: [],
  failure: null,
  provisioning: 'ok',
  createdAt: '2026-10-05T12:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
  signedOffAt: null,
  doingSince: '2026-10-05T12:00:00.000Z',
});

describe('deploys in Postgres', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let service: DeployService;
  let board: Board;
  let n = 0;
  let clock = Date.parse('2026-10-05T12:00:00.000Z');

  beforeAll(async () => {
    const test = await createTestDatabase('deploys');
    drop = test.drop;
    store = new PgStore(test.database.db);
    service = new DeployService({
      store,
      notifier: { publish: () => undefined },
      // Each call a second later, so requests order by time as they do in production.
      clock: { now: () => new Date((clock += 1000)).toISOString() },
      newDeployId: () => `dep-${++n}`,
    });
    board = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      const inserted = await tx.insertBoard({
        name: 'sandbox',
        repo: 'acme/sandbox',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [{ name: 'dev1', allowBranchDeploy: true }],
        sensitivePaths: [],
      });
      expect(inserted.deploy).toBeNull();
      const withDeploy: Board = {
        ...inserted,
        deploy: { provider: 'codebuild', region: 'us-east-1', defaultProject: 'sandbox-deploy', projects: {} },
        version: inserted.version + 1,
      };
      expect(await tx.updateBoard(withDeploy, inserted.version)).toBe(true);
      await tx.upsertMember({ boardId: inserted.id, email: DEV, role: 'dev' });
      for (const id of ['s9f1', 's9f2', 's9f3']) await tx.insertGlob(glob(id, inserted.id), null);
      return withDeploy;
    });
  });

  afterAll(async () => {
    await drop();
  });

  it('stores the board integration', async () => {
    const stored = await store.transaction((tx) => tx.getBoard(board.id));
    expect(stored?.deploy).toEqual(board.deploy);
  });

  it('queues per environment, finds deploys by provider handle and shows the board state', async () => {
    const first = unwrap(await service.requestFromPush('s9f1', 'a1'));
    unwrap(await service.requestFromPush('s9f2', 'b1'));
    unwrap(await service.requestFromPush('s9f3', 'c1'));
    expect(first?.state).toBe('running');

    const all = await store.transaction((tx) => tx.listDeploys(board.id, {}));
    expect(all.map((d) => [d.globId, d.state])).toEqual([
      ['s9f3', 'waiting'],
      ['s9f2', 'replaced'],
      ['s9f1', 'running'],
    ]);
    const active = await store.transaction((tx) =>
      tx.listDeploys(board.id, { environment: 'dev1', states: ['waiting', 'running'] }),
    );
    expect(active).toHaveLength(2);
    expect(await store.transaction((tx) => tx.listDeploys(board.id, { globIds: [] }))).toEqual([]);

    unwrap(await service.started('dep-1', { providerRef: 'arn:build/1', url: 'https://example.com/1' }));
    expect((await store.transaction((tx) => tx.findDeployByProviderRef('arn:build/1')))?.id).toBe('dep-1');
    unwrap(await service.finishedByProviderRef('arn:build/1', { succeeded: true, error: null }));

    const third = await store.transaction((tx) => tx.getDeploy('dep-3'));
    expect(third?.state).toBe('running');
    const { indicators, running } = await service.boardState(board.id, ['s9f1', 's9f2', 's9f3']);
    expect(indicators.get('s9f1')).toEqual({ state: 'live', environment: 'dev1', sha: 'a1' });
    expect(indicators.get('s9f3')).toEqual({ state: 'deploying', environment: 'dev1', waiting: false });
    expect([...running]).toEqual(['dev1']);

    unwrap(await service.finished('dep-3', { succeeded: false, error: 'exit 2' }));
    const history = unwrap(await service.history(DEV, 's9f3'));
    expect(history[0]).toMatchObject({ state: 'failed', error: 'exit 2' });
  });
});
