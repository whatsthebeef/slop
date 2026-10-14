import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import { InvestigationService } from '../src/app/investigation-service.js';
import { blockProgress, listWithSteps, rolloutPending } from '../src/domain/human-steps.js';
import type { BlockProgress } from '../src/domain/human-steps.js';
import * as machine from '../src/domain/machine.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { ctx, glob as fixture, po, relation } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const PO = 'po@example.com';

describe('lifecycle with open blocking steps (pure)', () => {
  const reviewing = (patch: Partial<Glob> = {}) =>
    fixture({ status: 'reviewing', labels: { CR: 'required' }, pr: { number: 1, state: 'merged', headSha: 'a' }, ...patch });
  const approve = (g: Glob, rollout: BlockProgress | null) => unwrap(machine.reviewLabel(g, 'CR', { kind: 'approve' }, ctx(po), rollout));

  it('approving the last label signs off once no work steps are open', () => {
    expect(approve(reviewing(), null).glob.status).toBe('signed_off');
    expect(approve(reviewing(), { open: 0, total: 2 }).glob.status).toBe('signed_off');
  });

  it('refuses to approve a merged glob\'s label while a step holds sign-off back, and still takes other changes', () => {
    const refused = machine.reviewLabel(reviewing(), 'CR', { kind: 'approve' }, ctx(po), { open: 1, total: 2 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('Rollout pending (1 of 2)');
    const asked = unwrap(machine.reviewLabel(reviewing(), 'CR', { kind: 'submit_items', items: ['Check it'] }, ctx(po), { open: 1, total: 2 }));
    expect(asked.glob.labels.CR).toBe('added');
    const approved = reviewing({ labels: { CR: 'approved' } });
    expect(unwrap(machine.reviewLabel(approved, 'CR', { kind: 'approve' }, ctx(po), { open: 1, total: 2 })).changed).toBe(false);
  });

  it('refuses to sign off a decision while steps are open, saying how many', () => {
    const decision = fixture({ category: 'decision', type: 'same', status: 'reviewing' });
    const refused = machine.signOffDecision(decision, ctx(po), { open: 1, total: 3 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('Rollout pending (1 of 3)');
    expect(unwrap(machine.signOffDecision(decision, ctx(po), { open: 0, total: 3 })).glob.status).toBe('signed_off');
  });

  it('settling moves a merged glob with approved labels on, and only when nothing is open', () => {
    const approved = reviewing({ labels: { CR: 'approved' } });
    expect(unwrap(machine.rolloutSettled(approved, { open: 1, total: 1 }, ctx(null))).changed).toBe(false);
    expect(unwrap(machine.rolloutSettled(reviewing(), { open: 0, total: 1 }, ctx(null))).changed).toBe(false);
    const moved = unwrap(machine.rolloutSettled(approved, { open: 0, total: 1 }, ctx(null)));
    expect(moved.glob.status).toBe('signed_off');
    expect(moved.events.map((e) => e.type)).toContain('RolloutDone');
  });

  it('a merged glob with open blocking steps sits in Doing; dismissed and machine steps do not count', () => {
    const steps = [
      { state: 'pending' as const, blocks: ['sign_off' as const], source: 'work' as const },
      { state: 'due' as const, blocks: ['reviewing' as const], source: 'machine' as const },
      { state: 'dismissed' as const, blocks: ['sign_off' as const], source: 'work' as const },
    ];
    const progress = blockProgress(steps, 'sign_off');
    expect(progress).toEqual({ open: 1, total: 1 });
    expect(rolloutPending(progress)).toBe('Rollout pending (1 of 1)');
    expect(listWithSteps({ status: 'reviewing' }, progress)).toBe('doing');
    expect(listWithSteps({ status: 'reviewing' }, { open: 0, total: 1 })).toBe('reviewing');
    expect(listWithSteps({ status: 'signed_off' }, null)).toBe('signed_off');
  });
});

describe('work steps through the service', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  let runs: number;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Ship it',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const update = async (id: string, patch: Partial<Glob>): Promise<Glob> =>
    store.transaction(async (tx) => {
      const current = (await tx.getGlob(id)) as Glob;
      const next = { ...current, ...patch, version: current.version + 1 };
      await tx.updateGlob(next, current.version);
      return next;
    });
  /** `from` starts after `to` (a start relation row, as a person's `after` writes it). */
  const startsAfter = (from: string, to: string): void => {
    const row = relation(from, to);
    store.state.relations.set(row.id, row);
  };
  /** A merged glob in Reviewing, with the labels given. */
  const merged = async (labels: Glob['labels'] = { CR: 'approved' }): Promise<Glob> => {
    const created = unwrap(await globs.create(DEV, input()));
    return update(created.id, { status: 'reviewing', labels, pr: { number: 1, state: 'merged', headSha: 'abc1234' } });
  };
  const peek = async (id: string): Promise<Glob> => {
    const g = await globs.peek(id);
    if (g === null) throw new Error('missing');
    return g;
  };
  const waitsFor = async (id: string) => unwrap(await globs.get(DEV, id)).waitingFor;

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => '2026-10-13T12:00:00.000Z' };
    runs = 0;
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    const investigation = new InvestigationService({
      store,
      clock,
      notifier,
      escalate: (email, id, i) => globs.escalateToSame(email, id, i),
      predictRollout: (id) => globs.predictRollout(id),
    });
    artifacts = new ArtifactService({ store, clock, notifier, investigation });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, PO, 'outsider@example.com']) await tx.upsertUser({ email, name: email, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    unwrap(await boards.setMember(ADMIN, boardId, PO, 'po'));
  });

  it('adds a rollout step with its defaults, for members only', async () => {
    const g = await merged();
    const step = unwrap(await globs.addHumanStep(DEV, g.id, g.version, { title: ' Deploy the host stack ' }));
    expect(step).toMatchObject({ kind: 'rollout', title: 'Deploy the host stack', due: 'after_merge', state: 'open', blocks: ['sign_off', 'dependants'], who: 'anyone' });
    expect((await globs.addHumanStep('outsider@example.com', g.id, null, { title: 'x' })).ok).toBe(false);
    expect((await globs.addHumanStep(DEV, g.id, null, { title: ' ' })).ok).toBe(false);
    expect((await globs.addHumanStep(DEV, g.id, null, { title: 'x', due: 'whenever' })).ok).toBe(false);
    const stale = await globs.addHumanStep(DEV, g.id, g.version + 5, { title: 'x' });
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
  });

  it('the last blocking step moves a merged glob with approved labels on to Signed off', async () => {
    const g = await merged();
    const one = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Roll out the stack' }));
    const two = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Set the server env' }));
    unwrap(await globs.completeHumanStep(DEV, g.id, one.id, null));
    expect((await peek(g.id)).status).toBe('reviewing');
    const done = unwrap(await globs.completeHumanStep(PO, g.id, two.id, null));
    expect(done).toMatchObject({ state: 'done', doneBy: PO });
    const after = await peek(g.id);
    expect(after.status).toBe('signed_off');
    expect(after.signedOffAt).not.toBeNull();
  });

  it('a label can only be approved once the steps are done or dismissed', async () => {
    const g = await merged({ CR: 'required' });
    const step = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Roll out' }));
    const refused = await globs.reviewLabel(PO, g.id, (await peek(g.id)).version, 'CR', { kind: 'approve' });
    expect(!refused.ok && refused.error.message).toContain('Rollout pending (1 of 1)');
    unwrap(await globs.completeHumanStep(DEV, g.id, step.id, null));
    expect((await peek(g.id)).status).toBe('reviewing');
    const approved = unwrap(await globs.reviewLabel(PO, g.id, (await peek(g.id)).version, 'CR', { kind: 'approve' }));
    expect(approved.status).toBe('signed_off');
  });

  it('a label approved before a step appeared stays approved and signs off when the step is ticked', async () => {
    const g = await merged({ CR: 'approved' });
    const step = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Roll out' }));
    expect((await peek(g.id)).labels.CR).toBe('approved');
    unwrap(await globs.completeHumanStep(DEV, g.id, step.id, null));
    expect((await peek(g.id)).status).toBe('signed_off');
  });

  it('a decision cannot be signed off while a step is open', async () => {
    const created = unwrap(await globs.create(DEV, input()));
    const reviewing = await update(created.id, { category: 'decision', status: 'reviewing' });
    const decision = reviewing;
    const step = unwrap(await globs.addHumanStep(DEV, decision.id, null, { title: 'Tell the team', kind: 'decide', blocks: ['sign_off'] }));
    const refused = await globs.signOffDecision(ADMIN, decision.id, reviewing.version);
    expect(!refused.ok && refused.error.message).toContain('Rollout pending (1 of 1)');
    unwrap(await globs.completeHumanStep(DEV, decision.id, step.id, null));
    expect(unwrap(await globs.signOffDecision(ADMIN, decision.id, (await peek(decision.id)).version)).status).toBe('signed_off');
  });

  it('dismissing needs a reason and also clears the hold', async () => {
    const g = await merged();
    const step = unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Wrong step' }));
    expect((await globs.dismissHumanStep(DEV, g.id, step.id, ' ', null)).ok).toBe(false);
    const dismissed = unwrap(await globs.dismissHumanStep(DEV, g.id, step.id, 'Not needed', null));
    expect(dismissed).toMatchObject({ state: 'dismissed', dismissedReason: 'Not needed' });
    expect((await peek(g.id)).status).toBe('signed_off');
    expect((await globs.completeHumanStep(DEV, g.id, 'nope', null)).ok).toBe(false);
  });

  it('a dependant waits for the rollout, not just the merge', async () => {
    const needed = await merged();
    const later = unwrap(await globs.create(DEV, input({ title: 'Waits' })));
    startsAfter(later.id, needed.id);
    expect(await waitsFor(later.id)).toEqual([]);

    const step = unwrap(await globs.addHumanStep(DEV, needed.id, null, { title: 'Roll out' }));
    const waiting = await waitsFor(later.id);
    expect(waiting.map((w) => [w.id, w.state])).toEqual([[needed.id, 'rollout']]);
    expect(waiting[0]?.why).toContain('rollout');

    unwrap(await globs.completeHumanStep(DEV, needed.id, step.id, null));
    expect(await waitsFor(later.id)).toEqual([]);
  });

  it('a step that does not block dependants leaves them free', async () => {
    const needed = await merged();
    unwrap(await globs.addHumanStep(DEV, needed.id, null, { title: 'Tell the team', blocks: ['sign_off'] }));
    const later = unwrap(await globs.create(DEV, input({ title: 'Free' })));
    startsAfter(later.id, needed.id);
    expect(await waitsFor(later.id)).toEqual([]);
  });

  it('get and context return the steps; open blocking ones count against sign-off', async () => {
    const g = await merged();
    unwrap(await globs.addHumanStep(DEV, g.id, null, { title: 'Roll out' }));
    const view = unwrap(await globs.get(DEV, g.id));
    expect(view.humanSteps.map((s) => [s.title, s.state])).toEqual([['Roll out', 'due']]);
    expect(blockProgress(view.humanSteps, 'sign_off')).toEqual({ open: 1, total: 1 });
    expect(unwrap(await artifacts.context(DEV, g.id)).humanSteps.map((s) => s.title)).toEqual(['Roll out']);
  });

  it('a predicted rollout adds one placeholder step, and a dismissal of it stands', async () => {
    const g = unwrap(await globs.create(DEV, input()));
    const block = {
      files: [{ path: 'infra/stack.ts', change: 'modify' }],
      modules: ['infra'],
      expectedLines: { min: 1, max: 5 },
      parts: [],
      riskTier: 'normal',
      riskAreas: [],
      needsHuman: { needed: false, reason: null },
      confidence: 'medium',
      needsRollout: true,
      planHash: 'abc',
      baseCommit: 'def4567',
    };
    const submit = async (): Promise<void> => {
      unwrap(await artifacts.putArtifact(DEV, g.id, 'investigation', `# I\n\n\`\`\`investigation\n${JSON.stringify(block)}\n\`\`\`\n`, { commitSha: null, runId: null, agentSetVersion: null }));
    };
    await submit();
    await submit();
    const steps = [...store.state.humanSteps.values()];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'rollout', title: 'Rollout: steps to be written', origin: 'investigation', state: 'open', due: 'after_merge' });
    expect(unwrap(await globs.get(DEV, g.id)).humanSteps.map((s) => s.state)).toEqual(['pending']);
    unwrap(await globs.dismissHumanStep(DEV, g.id, steps[0]?.id ?? '', 'No rollout after all', null));
    await submit();
    expect([...store.state.humanSteps.values()]).toHaveLength(1);
  });
});
