import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const PO = 'po@example.com';

describe('services', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let boards: BoardService;
  let globs: GlobService;
  let boardId: number;
  let runs: number;
  let withRoutine: Set<string>;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Fix login timeout',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    runs = 0;
    withRoutine = new Set([DEV]);
    boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => '2026-10-05T12:00:00.000Z' },
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: (email, board) => Promise.resolve(withRoutine.has(email) || withRoutine.has(`${email}#${String(board)}`)) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, PO]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(
      await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    unwrap(await boards.setMember(ADMIN, boardId, PO, 'po'));
  });

  describe('who can choose sub or super', () => {
    const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);

    it('lets an admin create a sub, a same and a super', async () => {
      for (const type of ['sub', 'same', 'super'] as const) expect(unwrap(await globs.create(ADMIN, input({ type }))).type).toBe(type);
    });

    it('lets dev and po create a same only, refusing an explicit sub or super', async () => {
      for (const who of [DEV, PO]) {
        expect(unwrap(await globs.create(who, input({ type: 'same' }))).type).toBe('same');
        for (const type of ['sub', 'super'] as const) {
          const refused = await globs.create(who, input({ type }));
          expect(code(refused)).toBe('forbidden');
          if (!refused.ok) expect(refused.error.message).toBe('Only board admins can create a sub or a super; create it as a same and an admin can change its type');
        }
      }
    });

    it('makes a type nobody chose a same for a non-admin, and keeps an admin\'s', async () => {
      expect(unwrap(await globs.create(DEV, input({ type: 'sub', typeChosen: false }))).type).toBe('same');
      expect(unwrap(await globs.create(DEV, input({ type: 'super', typeChosen: false, start: false }))).type).toBe('same');
      expect(unwrap(await globs.create(ADMIN, input({ type: 'sub', typeChosen: false }))).type).toBe('sub');
    });

    it('refuses a type change to sub or super for a non-admin, allows it for an admin and a change to same for anyone', async () => {
      const same = unwrap(await globs.create(DEV, input()));
      expect(code(await globs.update(DEV, same.id, same.version, { type: 'sub' }))).toBe('forbidden');
      expect(code(await globs.update(DEV, same.id, same.version, { type: 'super' }))).toBe('forbidden');
      const asSuper = unwrap(await globs.update(ADMIN, same.id, same.version, { type: 'super' }));
      expect(asSuper.type).toBe('super');
      expect(unwrap(await globs.update(DEV, asSuper.id, asSuper.version, { type: 'same' })).type).toBe('same');
    });
  });

  it('numbers globs per board and ID letter', async () => {
    expect(unwrap(await globs.create(ADMIN, input())).id).toBe(`s${boardId}t1`);
    expect(unwrap(await globs.create(ADMIN, input())).id).toBe(`s${boardId}t2`);
    expect(unwrap(await globs.create(ADMIN, input({ category: 'bug' }))).id).toBe(`s${boardId}b1`);
  });

  it('stores a created feature as a task with the R&D work kind it implies; an explicit work kind wins', async () => {
    const feature = unwrap(await globs.create(ADMIN, input({ category: 'feature' })));
    expect(feature).toMatchObject({ category: 'task', workKind: 'rnd' });
    expect(feature.id).toBe(`s${boardId}t1`);
    const explicit = unwrap(await globs.create(ADMIN, input({ category: 'feature', workKind: 'maintenance', workKindSource: 'person' })));
    expect(explicit).toMatchObject({ category: 'task', workKind: 'maintenance', workKindSource: 'person' });
  });

  it('lists a glob\'s human steps on a read: a stored rollout step is pending until the PR merges', async () => {
    const glob = unwrap(await globs.create(ADMIN, input()));
    await store.transaction((tx) =>
      tx.saveHumanSteps([
        {
          id: 'hs-1',
          boardId,
          globId: glob.id,
          kind: 'rollout',
          title: 'Deploy the host stack',
          detail: null,
          who: 'admin',
          due: 'after_merge',
          state: 'open',
          blocks: ['sign_off'],
          check: null,
          script: null,
          why: null,
          permissions: null,
          commands: [],
          verify: null,
          origin: 'rollout-section',
          createdBy: DEV,
          createdAt: '2026-10-05T12:00:00.000Z',
          doneBy: null,
          doneAt: null,
          dismissedReason: null,
        },
      ]),
    );
    const read = unwrap(await globs.get(DEV, glob.id));
    expect(read.humanSteps.map((s) => [s.id, s.kind, s.state])).toEqual([['hs-1', 'rollout', 'pending']]);
    expect([...(await globs.humanStepsOf(boardId)).keys()]).toEqual([glob.id]);
  });

  it('returns the same glob for a repeated idempotency key', async () => {
    const first = unwrap(await globs.create(ADMIN, input({ idempotencyKey: 'k1' })));
    const again = unwrap(await globs.create(ADMIN, input({ idempotencyKey: 'k1' })));
    expect(again.id).toBe(first.id);
    expect(store.state.globs.size).toBe(1);
  });

  it('writes events and effects with the state change and publishes a hint', async () => {
    const glob = unwrap(await globs.create(ADMIN, input()));
    expect(store.state.events.map((e) => e.type)).toEqual(['GlobCreated', 'ArtifactAdded']);
    // A same in Planning has no branch yet; it provisions when work starts.
    expect(store.state.outbox.map((e) => e.kind)).toEqual([]);
    expect(notifier.hints).toContainEqual({ kind: 'glob.changed', boardId, globId: glob.id, version: 1 });
  });

  it('rejects stale versions with the current glob', async () => {
    const glob = unwrap(await globs.create(ADMIN, input()));
    unwrap(await globs.update(DEV, glob.id, 1, { group: 'Sync' }));
    const stale = await globs.start(DEV, glob.id, 1);
    expect(stale.ok).toBe(false);
    if (!stale.ok && stale.error.code === 'version_conflict' && 'current' in stale.error) {
      expect(stale.error.current.version).toBe(2);
    }
    expect(unwrap(await globs.start(DEV, glob.id, 2)).status).toBe('implementing');
  });

  it('runs routines as the triggerer, falling back to the board default', async () => {
    const mine = unwrap(await globs.create(ADMIN, input({ type: 'sub' })));
    expect(mine.runs[0]?.routineOwner).toBe(ADMIN);
    const fallback = unwrap(await globs.create(PO, input({ type: 'same', autoTrigger: true })));
    expect(fallback.runs[0]?.triggeredBy).toBe(PO);
    expect(fallback.runs[0]?.routineOwner).toBe(ADMIN);
  });

  it("counts a routine set up only for this board as the triggerer's own", async () => {
    withRoutine.add(`${PO}#${String(boardId)}`);
    const glob = unwrap(await globs.create(PO, input({ type: 'same', autoTrigger: true })));
    expect(glob.runs[0]?.routineOwner).toBe(PO);
  });

  it('refuses non-members and deactivated users', async () => {
    expect((await globs.create('stranger@example.com', input())).ok).toBe(false);
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: DEV, active: false }));
    const result = await globs.create(DEV, input());
    expect(!result.ok && result.error.code).toBe('forbidden');
  });

  it('applies integration events against the current version', async () => {
    const glob = unwrap(await globs.create(ADMIN, input({ type: 'sub' })));
    const runId = glob.runs[0]?.id ?? '';
    const ready = unwrap(
      await globs.applyEvent(glob.id, (g, ctx) =>
        machine.prReadyForReview(g, { number: 1, headSha: 'abc' }, ctx),
      ),
    );
    expect(ready.status).toBe('pr_open');
    expect(runId).toBe('run-1');
  });

  it('merge (row 14) needs the current version, then queues the squash merge', async () => {
    const glob = unwrap(await globs.create(ADMIN, input()));
    const picked = unwrap(await globs.pickUp(DEV, glob.id, glob.version, false));
    const ready = unwrap(
      await globs.applyEvent(picked.id, (g, ctx) => machine.prReadyForReview(g, { number: 7, headSha: 'abc' }, ctx)),
    );
    const passing = unwrap(
      await globs.applyEvent(ready.id, (g, ctx) => machine.checksCompleted(g, { sha: 'abc', passed: true }, ctx)),
    );
    const stale = await globs.merge(DEV, passing.id, passing.version - 1);
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
    expect(unwrap(await globs.merge(DEV, passing.id, passing.version)).status).toBe('merging');
    expect(store.state.outbox.at(-1)).toMatchObject({ kind: 'squash_merge', globId: glob.id, sha: 'abc' });
  });

  it('review now queues a fresh review every time, beside the automatic one for the same commit', async () => {
    const glob = unwrap(await globs.create(ADMIN, input()));
    const picked = unwrap(await globs.pickUp(DEV, glob.id, glob.version, false));
    unwrap(await globs.applyEvent(picked.id, (g, ctx) => machine.prReadyForReview(g, { number: 7, headSha: 'abc' }, ctx)));
    const reviews = () => store.state.outbox.flatMap((e) => (e.kind === 'review_change' ? [e] : []));
    expect(reviews()).toHaveLength(1);
    // The same commit again: the automatic review is deduplicated, the on-demand ones are not.
    await store.transaction((tx) => tx.enqueueEffects([{ kind: 'review_change', globId: glob.id, generation: 1, stage: 'pre_merge', sha: 'abc' }]));
    expect(reviews()).toHaveLength(1);
    unwrap(await globs.reviewNow(PO, glob.id));
    unwrap(await globs.reviewNow(PO, glob.id));
    const queued = reviews();
    expect(queued).toHaveLength(3);
    expect(queued.filter((e) => e.requestId !== undefined)).toHaveLength(2);
    expect(new Set(queued.map((e) => e.requestId)).size).toBe(3);
    // A later automatic review for a newer head cancels only the automatic one.
    unwrap(await globs.applyEvent(glob.id, (g, ctx) => machine.commitPushed(g, { sha: 'def', runId: null }, ctx)));
    expect(reviews().map((e) => `${e.sha}:${e.requestId === undefined ? 'auto' : 'asked'}`).sort()).toEqual(['abc:asked', 'abc:asked', 'def:auto']);
  });

  it('stores independent reviews as versioned artifacts tied to the commit, and the summary carries the finding count', async () => {
    const glob = unwrap(await globs.create(ADMIN, input()));
    const artifacts = new ArtifactService({ store, notifier, clock: { now: () => '2026-10-05T12:00:00.000Z' } });
    const meta = { stage: 'pre_merge' as const, headSha: 'abc', findings: 3, high: 1, medium: 1, low: 1 };
    const first = unwrap(await artifacts.addIndependentReview(glob.id, { content: '# review', commitSha: 'm1', meta, model: 'gpt-oss' }));
    const second = unwrap(await artifacts.addIndependentReview(glob.id, { content: '# again', commitSha: 'm2', meta: { ...meta, findings: 0, high: 0, medium: 0, low: 0 }, model: 'gpt-oss' }));
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(second).toMatchObject({ kind: 'independent_review', commitSha: 'm2', provenance: { by: 'reviewer', actor: 'gpt-oss' } });
    const summaries = await store.transaction((tx) => tx.listArtifactSummaries(boardId, [glob.id]));
    const summary = summaries.find((a) => a.kind === 'independent_review');
    expect(summary).toMatchObject({ kind: 'independent_review', version: 2, versions: 2, commitSha: 'm2', review: { findings: 0, stage: 'pre_merge' } });
    expect(notifier.hints.some((h) => h.kind === 'glob.artifacts' && h.globId === glob.id)).toBe(true);
    const missing = await artifacts.addIndependentReview('nope', { content: 'x', commitSha: 'm', meta, model: 'm' });
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });

  it('review now is refused for a glob still in Planning', async () => {
    const glob = unwrap(await globs.create(ADMIN, input()));
    const result = await globs.reviewNow(DEV, glob.id);
    expect(!result.ok && result.error.code).toBe('invalid_transition');
  });

  const putRecord = (globId: string, commitSha: string) =>
    store.transaction((tx) =>
      tx.insertArtifact({
        globId,
        kind: 'implementation_plan',
        label: '',
        content: '# record',
        link: null,
        commitSha,
        provenance: { by: 'sessionator', actor: DEV, runId: null, agentSetVersion: null },
        createdAt: '2026-10-05T12:00:00.000Z',
      }),
    );

  it('merge and continue (row 31) needs the latest implementation record at the head', async () => {
    const created = unwrap(await globs.create(ADMIN, input({ type: 'super', category: 'feature' })));
    const glob = unwrap(await globs.pickUp(DEV, created.id, created.version, false));
    const head = 'abcdef0123456789';
    unwrap(await globs.applyEvent(glob.id, (g, ctx) => machine.prReadyForReview(g, { number: 7, headSha: head }, ctx)));
    const passing = unwrap(
      await globs.applyEvent(glob.id, (g, ctx) => machine.checksCompleted(g, { sha: head, passed: true }, ctx)),
    );
    await putRecord(glob.id, 'fff0000');
    expect(unwrap(await globs.get(DEV, glob.id)).allowedActions).not.toContain('merge_continue');
    const behind = await globs.merge(DEV, glob.id, passing.version, true);
    expect(!behind.ok && behind.error.code).toBe('invalid_transition');

    await putRecord(glob.id, head.slice(0, 7));
    expect(unwrap(await globs.get(DEV, glob.id)).allowedActions).toContain('merge_continue');
    const merging = unwrap(await globs.merge(DEV, glob.id, passing.version, true));
    expect(merging).toMatchObject({ status: 'merging', mergeMode: 'continue' });
    const continued = unwrap(
      await globs.applyEvent(glob.id, (g, ctx) => machine.merged(g, { sha: 'm1', number: 7 }, ctx)),
    );
    expect(continued).toMatchObject({ status: 'in_progress', pr: null, labels: {} });
    expect(continued.prs.map((p) => p.number)).toEqual([7]);
  });

  it("mark_ready from the board (supers) needs the latest implementation record at the draft PR's head", async () => {
    const created = unwrap(await globs.create(ADMIN, input({ type: 'super', category: 'feature' })));
    const glob = unwrap(await globs.pickUp(DEV, created.id, created.version, false));
    const head = 'abcdef0123456789';
    const drafted = unwrap(
      await globs.applyEvent(glob.id, (g, ctx) =>
        machine.provisioned(g, { branch: g.id, pr: { number: 7, headSha: head } }, ctx),
      ),
    );
    expect(unwrap(await globs.get(DEV, glob.id)).allowedActions).not.toContain('mark_ready');
    const without = await globs.requestReadyFromBoard(DEV, glob.id, drafted.version);
    expect(!without.ok && without.error.message).toBe(machine.RECORD_NOT_AT_HEAD);

    await putRecord(glob.id, head);
    expect(unwrap(await globs.get(DEV, glob.id)).allowedActions).toContain('mark_ready');
    unwrap(await globs.requestReadyFromBoard(DEV, glob.id, drafted.version));
    expect(store.state.outbox.at(-1)).toMatchObject({ kind: 'mark_pr_ready', globId: glob.id });
  });

  it('delete removes the glob and its events and queues the clean-up', async () => {
    const glob = unwrap(await globs.create(ADMIN, input()));
    unwrap(await globs.delete(PO, glob.id, 1));
    expect(store.state.globs.size).toBe(0);
    expect(store.state.events).toEqual([]);
    expect(store.state.outbox.map((e) => e.kind)).toEqual(['delete_glob_data', 'recheck_overlaps']);
    expect(notifier.hints.at(-1)).toMatchObject({ kind: 'glob.deleted', globId: glob.id });
  });

  it('review checklist commands need the current version and log who acted', async () => {
    const glob = unwrap(await globs.create(ADMIN, input({ type: 'sub' })));
    const reviewing = unwrap(await globs.applyEvent(glob.id, (g, ctx) => machine.merged(g, { sha: 'abc' }, ctx)));
    const added = unwrap(
      await globs.reviewLabel(PO, reviewing.id, reviewing.version, 'QA', { kind: 'submit_items', items: ['Check copy'] }),
    );
    expect(added.labels.QA).toBe('added');
    const stale = await globs.reviewLabel(DEV, added.id, reviewing.version, 'QA', { kind: 'resubmit' });
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
    const ticked = unwrap(
      await globs.reviewLabel(DEV, added.id, added.version, 'QA', { kind: 'tick', itemId: '1', done: true }),
    );
    const signedOff = unwrap(await globs.reviewLabel(PO, ticked.id, ticked.version, 'QA', { kind: 'approve' }));
    expect(signedOff.status).toBe('signed_off');
    // Signing a work glob off queues the knowledge page's regeneration (once per board).
    expect(store.state.outbox.filter((e) => e.kind === 'regenerate_knowledge_page')).toEqual([{ kind: 'regenerate_knowledge_page', globId: 'board-1', boardId: 1 }]);
    expect(store.state.events.filter((e) => e.type.startsWith('Label')).map((e) => [e.type, e.actor])).toEqual([
      ['LabelChanged', PO],
      ['LabelItemTicked', DEV],
      ['LabelChanged', PO],
    ]);
  });

  it('only admins manage members, and a board keeps one admin', async () => {
    expect((await boards.setMember(DEV, boardId, 'x@example.com', 'dev')).ok).toBe(false);
    const demote = await boards.setMember(ADMIN, boardId, ADMIN, 'dev');
    expect(demote.ok).toBe(false);
    expect((await boards.memberships(DEV)).map((m) => m.role)).toEqual(['dev']);
  });

  it("allows at most one subs' default environment, and only one that allows branch deploys", async () => {
    const two = await boards.updateSettings(ADMIN, boardId, 1, {
      environments: [
        { name: 'a', allowBranchDeploy: true, subDefault: true },
        { name: 'b', allowBranchDeploy: true, subDefault: true },
      ],
    });
    expect(two.ok).toBe(false);
    const locked = await boards.updateSettings(ADMIN, boardId, 1, {
      environments: [{ name: 'a', allowBranchDeploy: false, subDefault: true }],
    });
    expect(locked.ok).toBe(false);
    const board = unwrap(
      await boards.updateSettings(ADMIN, boardId, 1, {
        environments: [{ name: 'a', allowBranchDeploy: true, subDefault: true }, { name: 'b', allowBranchDeploy: true }],
      }),
    );
    expect(board.environments[0]?.subDefault).toBe(true);
  });

  it('allows one production environment, and only a release one', async () => {
    const two = await boards.updateSettings(ADMIN, boardId, 1, {
      environments: [
        { name: 'a', allowBranchDeploy: false, role: 'release', production: true },
        { name: 'b', allowBranchDeploy: false, role: 'release', production: true },
      ],
    });
    expect(two.ok).toBe(false);
    const integration = await boards.updateSettings(ADMIN, boardId, 1, {
      environments: [{ name: 'a', allowBranchDeploy: false, role: 'integration', production: true }],
    });
    expect(integration.ok).toBe(false);
    const board = unwrap(
      await boards.updateSettings(ADMIN, boardId, 1, {
        environments: [
          { name: 'dev', allowBranchDeploy: true, role: 'integration' },
          { name: 'prod', allowBranchDeploy: false, role: 'release', production: true },
        ],
      }),
    );
    expect(board.environments.map((e) => [e.role, e.production])).toEqual([
      ['integration', undefined],
      ['release', true],
    ]);
  });

  it('pick-up takes an optional environment and keeps the current one when it is left out', async () => {
    unwrap(await boards.updateSettings(ADMIN, boardId, 1, { environments: [{ name: 'dev', allowBranchDeploy: true }] }));
    const glob = unwrap(await globs.create(ADMIN, input()));
    const picked = unwrap(await globs.pickUp(DEV, glob.id, glob.version, false, 'dev'));
    expect(picked.environment).toBe('dev');
    const again = unwrap(await globs.pickUp(DEV, picked.id, picked.version, false));
    expect(again.environment).toBe('dev');
    expect(again.version).toBe(picked.version);
  });
});
