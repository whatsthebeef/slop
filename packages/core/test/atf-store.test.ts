import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import type { NewTestRun } from '../src/domain/test-runs.js';
import type { AtfIntegration } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW } from './fixtures.js';

const run = (patch: Partial<NewTestRun> = {}): NewTestRun => ({
  boardId: 1,
  kind: 'atf',
  globId: 's1t1',
  environment: 'qa',
  sha: 'abc1234',
  passed: 3,
  failed: 1,
  skipped: 0,
  url: null,
  finishedAt: NOW,
  eventId: 'e1',
  ...patch,
});

describe('per-spec test results in the store', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('writes the spec rows with the run and reads them back by run', async () => {
    const specs = [
      { spec: 'e2e/a.spec.ts', status: 'passed', tests: 2, failedTests: 0, durationMs: 1200 },
      { spec: 'e2e/b.spec.ts', status: 'failed', tests: 2, failedTests: 1, durationMs: null },
      { spec: 'e2e/c.spec.ts', status: 'missing', tests: 0, failedTests: 0, durationMs: null },
    ] as const;
    expect(await store.transaction((tx) => tx.insertTestRun(run({ specs })))).toBe(true);
    await store.transaction((tx) => tx.insertTestRun(run({ eventId: 'e2' })));
    const runs = await store.transaction((tx) =>
      tx.listTestRuns(1, { globIds: ['s1t1'] }),
    );
    expect(runs).toHaveLength(2);
    // The run itself carries no spec rows.
    expect(runs.every((r) => !('specs' in r))).toBe(true);
    const rows = await store.transaction((tx) => tx.listTestRunSpecs(runs.map((r) => r.id)));
    expect(rows.map((r) => [r.testRunId, r.spec, r.status])).toEqual(
      specs.map((s) => [runs.find((r) => r.eventId === 'e1')?.id, s.spec, s.status]),
    );
    expect(await store.transaction((tx) => tx.listTestRunSpecs([]))).toEqual([]);
  });

  it('records a redelivered event once, rows included', async () => {
    const specs = [
      { spec: 'a.spec.ts', status: 'passed', tests: 1, failedTests: 0, durationMs: null },
    ] as const;
    await store.transaction((tx) => tx.insertTestRun(run({ specs })));
    expect(await store.transaction((tx) => tx.insertTestRun(run({ specs })))).toBe(false);
    expect(await store.transaction((tx) => tx.listTestRunSpecs([1, 2, 3]))).toHaveLength(1);
  });

  it('drops a deleted glob’s branch runs with their spec rows', async () => {
    const specs = [
      { spec: 'a.spec.ts', status: 'passed', tests: 1, failedTests: 0, durationMs: null },
    ] as const;
    await store.transaction(async (tx) => {
      await tx.insertTestRun(run({ globId: 's1t1', environment: null, specs }));
    });
    expect(store.state.testRunSpecs).toHaveLength(1);
    await store.transaction((tx) => tx.deleteGlob('s1t1'));
    expect(store.state.testRunSpecs).toEqual([]);
  });
});

describe('the board ATF setting', () => {
  const ADMIN = 'admin@example.com';
  const SERVER_ADMIN = 'ops@example.com';
  const policy = { projects: ['atf', 'ci-*'], roleAccounts: ['123456789012'] };
  const atf: AtfIntegration = {
    provider: 'codebuild',
    region: 'us-east-1',
    project: 'atf',
    roleArn: 'arn:aws:iam::123456789012:role/r',
    mode: 'push',
  };
  let boards: BoardService;
  let boardId: number;
  let version: number;

  const setUp = async (atfPolicy: typeof policy | null = policy): Promise<void> => {
    const store = new MemoryStore();
    boards = new BoardService({
      store,
      notifier: new RecordingNotifier(),
      ...(atfPolicy === null ? {} : { atfPolicy }),
      serverAdmins: [SERVER_ADMIN],
      newExternalId: () => 'ext-1',
      clock: { now: () => NOW },
    });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    await store.transaction((tx) => tx.upsertUser({ email: SERVER_ADMIN, name: SERVER_ADMIN, active: true }));
    const created = await boards.create(ADMIN, { name: 'b', repo: null, timeZone: 'UTC', environments: [] });
    if (!created.ok) throw new Error(created.error.message);
    boardId = created.value.id;
    version = created.value.version;
    unwrapOk(await boards.setMember(ADMIN, boardId, SERVER_ADMIN, 'admin'));
  };
  const unwrapOk = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };

  beforeEach(async () => {
    await setUp();
  });

  it('is saved by a server admin with an ExternalId and who changed it, and cleared with null', async () => {
    const saved = unwrapOk(await boards.updateSettings(SERVER_ADMIN, boardId, version, { atf }));
    expect(saved.atf).toEqual({ ...atf, externalId: 'ext-1', pushChangedBy: SERVER_ADMIN, pushChangedAt: NOW });
    expect(saved.deploy).toBeNull();
    const cleared = await boards.updateSettings(ADMIN, boardId, saved.version, { atf: null });
    expect(cleared.ok && cleared.value.atf).toBeNull();
  });

  it('refuses a request that carries its own ExternalId: slop generates it, and keeps it when the role changes', async () => {
    const saved = unwrapOk(await boards.updateSettings(SERVER_ADMIN, boardId, version, { atf: { ...atf, externalId: 'mine' } }));
    expect(saved.atf?.externalId).toBe('ext-1');
    const moved = unwrapOk(
      await boards.updateSettings(SERVER_ADMIN, boardId, saved.version, {
        atf: { ...atf, roleArn: 'arn:aws:iam::123456789012:role/other' },
      }),
    );
    expect(moved.atf?.externalId).toBe('ext-1');
  });

  it("doesn't let a board admin turn on or change push mode", async () => {
    const refused = await boards.updateSettings(ADMIN, boardId, version, { atf });
    expect(!refused.ok && refused.error.code).toBe('forbidden');
    const saved = unwrapOk(await boards.updateSettings(SERVER_ADMIN, boardId, version, { atf }));
    const changed = await boards.updateSettings(ADMIN, boardId, saved.version, { atf: { ...atf, project: 'ci-other' } });
    expect(!changed.ok && changed.error.code).toBe('forbidden');
    const roleSwap = await boards.updateSettings(ADMIN, boardId, saved.version, { atf: { ...atf, roleArn: 'arn:aws:iam::123456789012:role/x' } });
    expect(!roleSwap.ok && roleSwap.error.code).toBe('forbidden');
  });

  it('gives a legacy push role with no ExternalId one when a server admin saves it again; a board admin gets forbidden first', async () => {
    const legacy: AtfIntegration = { provider: atf.provider, region: atf.region, project: atf.project, roleArn: atf.roleArn, mode: 'push' };
    const store = new MemoryStore();
    boards = new BoardService({ store, notifier: new RecordingNotifier(), atfPolicy: policy, serverAdmins: [SERVER_ADMIN], newExternalId: () => 'ext-2', clock: { now: () => NOW } });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    await store.transaction((tx) => tx.upsertUser({ email: SERVER_ADMIN, name: SERVER_ADMIN, active: true }));
    const created = unwrapOk(await boards.create(ADMIN, { name: 'c', repo: null, timeZone: 'UTC', environments: [] }));
    unwrapOk(await boards.setMember(ADMIN, created.id, SERVER_ADMIN, 'admin'));
    await store.transaction(async (tx) => {
      const b = await tx.getBoard(created.id);
      if (b !== null) await tx.updateBoard({ ...b, atf: legacy }, b.version);
    });
    const current = unwrapOk(await boards.get(ADMIN, created.id)).board;
    const resaved = unwrapOk(await boards.updateSettings(SERVER_ADMIN, created.id, current.version, { atf: legacy }));
    expect(resaved.atf?.externalId).toBe('ext-2');
    const outside = await boards.updateSettings(ADMIN, created.id, resaved.version, { atf: { ...legacy, project: 'prod-deploy' } });
    expect(!outside.ok && outside.error.code).toBe('forbidden');
  });

  it('lets a board admin leave a push setup as it is, or switch to pull', async () => {
    const saved = unwrapOk(await boards.updateSettings(SERVER_ADMIN, boardId, version, { atf }));
    const same = unwrapOk(await boards.updateSettings(ADMIN, boardId, saved.version, { atf }));
    expect(same.atf).toEqual(saved.atf);
    const pull = unwrapOk(await boards.updateSettings(ADMIN, boardId, same.version, { atf: { ...atf, mode: 'pull' } }));
    expect(pull.atf?.mode).toBe('pull');
    expect(pull.atf?.externalId).toBe('ext-1');
  });

  it('refuses a project or role outside the server allow-list at save time', async () => {
    const project = await boards.updateSettings(SERVER_ADMIN, boardId, version, { atf: { ...atf, project: 'prod-deploy' } });
    expect(!project.ok && project.error.code).toBe('invalid_input');
    const role = await boards.updateSettings(SERVER_ADMIN, boardId, version, {
      atf: { ...atf, roleArn: 'arn:aws:iam::999999999999:role/r' },
    });
    expect(!role.ok && role.error.code).toBe('invalid_input');
    const prefixed = await boards.updateSettings(SERVER_ADMIN, boardId, version, { atf: { ...atf, project: 'ci-deploy' } });
    expect(prefixed.ok).toBe(true);
  });

  it('keeps push mode off without an allow-list, even for a server admin', async () => {
    await setUp(null);
    const refused = await boards.updateSettings(SERVER_ADMIN, boardId, version, { atf });
    expect(!refused.ok && refused.error.code).toBe('invalid_input');
    const pull = await boards.updateSettings(ADMIN, boardId, version, { atf: { ...atf, mode: 'pull' } });
    expect(pull.ok).toBe(true);
  });

  it('needs a region and a project', async () => {
    const refused = await boards.updateSettings(ADMIN, boardId, version, {
      atf: { ...atf, project: ' ', mode: 'pull' },
    });
    expect(!refused.ok && refused.error.code).toBe('invalid_input');
  });
});
