import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { ARTIFACT_KINDS, ARTIFACT_ROLE } from '../src/domain/knowledge.js';
import type { Result } from '../src/domain/errors.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const OUTSIDER = 'outsider@example.com';
const GOOD =
  '| Name | Status | Location | Description |\n|---|---|---|---|\n| A | existing | `a.spec.ts` | runs |\n\n```atf-specs\nspecs:\n  - a.spec.ts\ngrep: "@a"\n```\n';
const BAD =
  '| Name | Status | Location | Description |\n|---|---|---|---|\n| A | existing | `a.spec.ts` | runs |\n';

describe('the test plan artifact', () => {
  let store: MemoryStore;
  let artifacts: ArtifactService;
  let globs: GlobService;
  let notifier: RecordingNotifier;
  let globId: string;

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    const clock = { now: () => '2026-10-11T12:00:00.000Z' };
    let runs = 0;
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    artifacts = new ArtifactService({ store, clock, notifier });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, OUTSIDER])
        await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    const boardId = unwrap(
      await boards.create(ADMIN, {
        name: 'demo',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    globId = unwrap(
      await globs.create(ADMIN, {
        boardId,
        title: 'T',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        plan: '## Tasks\n- [ ] x\n',
      }),
    ).id;
  });

  it('is a record kind, so get_context serves it in full and does not list it', () => {
    expect(ARTIFACT_KINDS).toContain('test_plan');
    expect(ARTIFACT_ROLE.test_plan).toBe('record');
  });

  it('saves versions and reads them back with the parsed specs', async () => {
    unwrap(await artifacts.putTestPlan(ADMIN, globId, GOOD));
    const second = unwrap(
      await artifacts.putTestPlan(ADMIN, globId, GOOD.replace('"@a"', 'null'), 1),
    );
    expect(second).toMatchObject({ kind: 'test_plan', version: 2 });
    const read = unwrap(await artifacts.testPlan(ADMIN, globId, null));
    expect(read.kind).toBe('test_plan');
    expect(read.current?.version).toBe(2);
    expect(read.current?.provenance.atfSpecs).toEqual({ specs: ['a.spec.ts'], grep: null });
    expect(read.current?.provenance.validation).toBeUndefined();
    expect(read.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(
      unwrap(await artifacts.testPlan(ADMIN, globId, 1)).current?.provenance.atfSpecs?.grep,
    ).toBe('@a');
    const missing = await artifacts.testPlan(ADMIN, globId, 9);
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });

  it('has no current version before the first save, and does not mix with plan.md versions', async () => {
    expect(unwrap(await artifacts.testPlan(ADMIN, globId, null)).current).toBeNull();
    unwrap(await artifacts.putTestPlan(ADMIN, globId, GOOD));
    expect(unwrap(await artifacts.plan(ADMIN, globId, null)).versions).toHaveLength(1);
    expect(unwrap(await artifacts.plan(ADMIN, globId, null)).current?.kind).toBe('plan');
  });

  it('stores a plan with problems anyway, with the note and no list when the block is missing', async () => {
    const stored = unwrap(await artifacts.putTestPlan(ADMIN, globId, BAD));
    if ('ignored' in stored) throw new Error('ignored');
    expect(stored.content).toBe(BAD);
    expect(stored.provenance.validation).toMatch(
      /^Test plan not fully valid: No ```atf-specs block/,
    );
    expect(stored.provenance.atfSpecs).toBeUndefined();
  });

  it('refuses a stale version with version_conflict, and 0 is the first', async () => {
    const first = await artifacts.putTestPlan(ADMIN, globId, GOOD, 0);
    expect(first.ok).toBe(true);
    const stale = await artifacts.putTestPlan(ADMIN, globId, GOOD, 0);
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
    expect(!stale.ok && stale.error.message).toBe(
      'The test plan is at version 1, not 0: read it again and retry',
    );
    // plan.md keeps its own message and its own counter.
    const plan = await artifacts.putPlan(ADMIN, globId, 'new plan', 0);
    expect(!plan.ok && plan.error.message).toBe(
      'plan.md is at version 1, not 0: read it again and retry',
    );
    expect((await artifacts.putTestPlan(ADMIN, globId, GOOD)).ok).toBe(true);
  });

  it('checks put_artifact against expectedVersion for a test plan', async () => {
    unwrap(await artifacts.putTestPlan(ADMIN, globId, GOOD));
    const put = await artifacts.putArtifact(ADMIN, globId, 'test_plan', GOOD, {
      commitSha: null,
      runId: null,
      agentSetVersion: null,
      expectedVersion: 0,
    });
    expect(!put.ok && put.error.code).toBe('version_conflict');
  });

  it('writes through put_artifact(kind test_plan) with a run, and ignores a superseded run', async () => {
    const ignored = unwrap(
      await artifacts.putArtifact(ADMIN, globId, 'test_plan', GOOD, {
        commitSha: null,
        runId: 'nope',
        agentSetVersion: null,
      }),
    );
    expect('ignored' in ignored).toBe(true);
    expect(unwrap(await artifacts.testPlan(ADMIN, globId, null)).current).toBeNull();
    const empty = await artifacts.putArtifact(ADMIN, globId, 'test_plan', '  ', {
      commitSha: null,
      runId: null,
      agentSetVersion: null,
    });
    expect(!empty.ok && empty.error.code).toBe('invalid_input');
  });

  it('runs none of the plan.md side effects and publishes glob.artifacts', async () => {
    const queued = store.state.outbox.length;
    unwrap(await artifacts.putTestPlan(ADMIN, globId, GOOD));
    expect(store.state.outbox.length).toBe(queued);
    expect(notifier.hints.some((h) => h.kind === 'glob.artifacts')).toBe(true);
  });

  it('is served in full by context(), null before the first save, with the validation note', async () => {
    expect(unwrap(await artifacts.context(ADMIN, globId)).testPlan).toBeNull();
    unwrap(await artifacts.putTestPlan(ADMIN, globId, BAD));
    const bad = unwrap(await artifacts.context(ADMIN, globId));
    expect(bad.testPlan).toMatchObject({ version: 1, content: BAD, atfSpecs: null });
    expect(bad.testPlan?.validation).toMatch(/not fully valid/);
    unwrap(await artifacts.putTestPlan(ADMIN, globId, GOOD, 1));
    const good = unwrap(await artifacts.context(ADMIN, globId));
    expect(good.testPlan).toEqual({
      version: 2,
      content: GOOD,
      atfSpecs: { specs: ['a.spec.ts'], grep: '@a' },
      validation: null,
    });
    expect(good.available.map((a) => a.kind)).not.toContain('test_plan');
    expect(good.plan?.content).toBe('## Tasks\n- [ ] x\n');
  });

  it('needs a board member to read or write', async () => {
    const write = await artifacts.putTestPlan(OUTSIDER, globId, GOOD);
    expect(!write.ok && write.error.code).toBe('forbidden');
    const read = await artifacts.testPlan(OUTSIDER, globId, null);
    expect(!read.ok && read.error.code).toBe('forbidden');
  });
});
