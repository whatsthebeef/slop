import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import type { StoredHumanStep } from '../src/domain/human-steps.js';
import type { Glob, Relation } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const message = <T>(result: Result<T>): string => (result.ok ? '' : result.error.message);

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';

describe('supersedes: one glob makes another obsolete', () => {
  let store: MemoryStore;
  let boards: BoardService;
  let globs: GlobService;
  let boardId: number;
  let runs: number;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Work',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const make = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrap(await globs.create(ADMIN, input(patch)));
  const peek = async (id: string): Promise<Glob> => {
    const g = await globs.peek(id);
    if (g === null) throw new Error(`No glob ${id}`);
    return g;
  };
  /** A merged glob (Reviewing) with the labels given. */
  const merged = async (title: string, labels: Glob['labels'] = { CR: 'approved' }): Promise<Glob> => {
    const g = await make({ title });
    return store.transaction(async (tx) => {
      const next = { ...g, status: 'reviewing' as const, labels, pr: { number: 1, state: 'merged' as const, headSha: 'abc1234' }, version: g.version + 1 };
      await tx.updateGlob(next, g.version);
      return next;
    });
  };
  const stepsOf = (id: string): StoredHumanStep[] => [...store.state.humanSteps.values()].filter((s) => s.globId === id);
  const all = (): Relation[] => [...store.state.relations.values()];
  const supersessionRows = (): Relation[] => all().filter((r) => r.kind === 'superseded_by');

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    boards = new BoardService({ store, notifier });
    globs = new GlobService({ store, notifier, clock: { now: () => '2026-10-15T12:00:00.000Z' }, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [{ name: 'staging', allowBranchDeploy: false }, { name: 'production', allowBranchDeploy: false }, { name: 'prod', allowBranchDeploy: false }] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('s14t13 supersedes s14t11: the row lands on the superseded glob, its open steps are dismissed, sign-off moves, waiters are released', async () => {
    const old = await merged('Remove the token');
    const due = unwrap(await globs.addHumanStep(ADMIN, old.id, null, { title: 'Rotate the token' }));
    const later = unwrap(await globs.addHumanStep(ADMIN, old.id, null, { title: 'Check prod', due: 'after_deploy:prod' }));
    // A glob waiting for the old one's rollout.
    const waiter = await make({ type: 'sub', after: [old.id] });
    expect(waiter.status).toBe('planning');
    expect(old.status).toBe('reviewing');

    const made = unwrap(await globs.createWithNotes(ADMIN, input({ title: 'Replace the token flow', supersedes: [{ id: old.id, reason: 'the new flow makes the token obsolete' }], by: 'agent' })));
    expect(made.notes.supersedes).toEqual([{ id: old.id, ok: true, why: 'added' }]);
    expect(supersessionRows()).toMatchObject([{ from: old.id, to: made.glob.id, kind: 'superseded_by', gate: 'sign_off', until: 'merged', source: 'agent', reason: 'the new flow makes the token obsolete' }]);

    // Every open step is dismissed with the reason, by slop, with a link in the event.
    for (const id of [due.id, later.id]) {
      expect(stepsOf(old.id).find((s) => s.id === id)).toMatchObject({ state: 'dismissed', dismissedReason: `superseded by ${made.glob.id}`, doneBy: 'slop' });
    }
    const events = store.state.events.filter((e) => e.type === 'HumanStepChanged' && e.globId === old.id && e.data.change === 'dismissed');
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toMatchObject({ link: made.glob.id });
    // Sign-off is no longer blocked by those steps: the glob moves on (approved labels), and the globs that waited for its rollout are released.
    expect((await peek(old.id)).status).toBe('signed_off');
    expect((await peek(waiter.id)).status).toBe('implementing');
    // Views.
    const oldView = unwrap(await globs.get(ADMIN, old.id));
    expect(oldView.relationGroups.supersededBy).toMatchObject({ id: made.glob.id, title: 'Replace the token flow', reason: 'the new flow makes the token obsolete', source: 'agent' });
    const newView = unwrap(await globs.get(ADMIN, made.glob.id));
    expect(newView.relationGroups.supersedes).toMatchObject([{ id: old.id }]);
    expect(unwrap(await globs.get(ADMIN, waiter.id)).relationGroups.supersededBy).toBeUndefined();
  });

  it('deleting the superseder removes the label: later steps on the superseded glob stay open (R1-4)', async () => {
    const old = await merged('Old', { CR: 'required' });
    const made = await make({ title: 'New' });
    unwrap(await globs.addSupersession(ADMIN, made.id, old.id, { reason: 'replaced' }, 'agent'));
    expect(supersessionRows()).toHaveLength(1);
    unwrap(await globs.delete(ADMIN, made.id, (await peek(made.id)).version));
    expect(supersessionRows()).toEqual([]);
    const added = unwrap(await globs.addHumanStep(ADMIN, old.id, null, { title: 'Late step' }));
    expect(added.state).toBe('open');
    expect(unwrap(await globs.get(ADMIN, old.id)).relationGroups.supersededBy).toBeUndefined();
  });

  it('steps added later (by hand or from the record) are dismissed at once', async () => {
    const old = await merged('Old', { CR: 'required' });
    const made = await make({ title: 'New' });
    unwrap(await globs.addSupersession(ADMIN, made.id, old.id, { reason: 'replaced' }, 'agent'));
    const added = unwrap(await globs.addHumanStep(ADMIN, old.id, null, { title: 'Late step' }));
    expect(added).toMatchObject({ state: 'dismissed', dismissedReason: `superseded by ${made.id}`, doneBy: 'slop' });
    await globs.reconcileRollout(ADMIN, old.id, '## Rollout\n- manual: Create the groups\n  - Why: the buildspec needs them\n', { commitSha: null, runId: null, agentSetVersion: null });
    expect(stepsOf(old.id).filter((s) => s.state === 'open')).toEqual([]);
    expect(stepsOf(old.id).map((s) => s.title).sort()).toEqual(['Create the groups', 'Late step']);
  });

  it('supersedes via update_glob and add_relation; the same row again changes nothing; a person re-adding a dismissed label restores it', async () => {
    const old = await make({ title: 'Old' });
    const a = await make({ title: 'A' });
    const updated = unwrap(await globs.update(ADMIN, a.id, a.version, { supersedes: [old.id] }));
    expect(updated.id).toBe(a.id);
    expect(supersessionRows()).toMatchObject([{ from: old.id, to: a.id, source: 'person', reason: null }]);
    const before = (await peek(old.id)).version;
    unwrap(await globs.addSupersession(ADMIN, a.id, old.id, {}, 'person'));
    expect((await peek(old.id)).version).toBe(before);
    expect(supersessionRows()).toHaveLength(1);
    // Dismissal removes the label (steps already dismissed stay so), and the row can be written again.
    const label = supersessionRows()[0];
    unwrap(await globs.dismissRelation(ADMIN, old.id, null, label?.id ?? ''));
    expect(unwrap(await globs.get(ADMIN, old.id)).relationGroups.supersededBy).toBeUndefined();
    expect(unwrap(await globs.get(ADMIN, a.id)).relationGroups.supersedes).toBeUndefined();
    unwrap(await globs.addSupersession(ADMIN, a.id, old.id, { reason: 'again' }, 'person'));
    expect(unwrap(await globs.get(ADMIN, old.id)).relationGroups.supersededBy).toMatchObject({ id: a.id, reason: 'again' });
  });

  it('dismissing the label leaves the steps it dismissed dismissed (history)', async () => {
    const old = await merged('Old', { CR: 'required' });
    const step = unwrap(await globs.addHumanStep(ADMIN, old.id, null, { title: 'Roll out' }));
    const a = await make({ title: 'A' });
    unwrap(await globs.addSupersession(ADMIN, a.id, old.id, { reason: 'r' }, 'agent'));
    unwrap(await globs.dismissRelation(ADMIN, old.id, null, supersessionRows()[0]?.id ?? ''));
    expect(stepsOf(old.id).find((s) => s.id === step.id)?.state).toBe('dismissed');
  });

  it('refuses a reverse cycle (B already supersedes A), a self-supersession, and an agent without a reason', async () => {
    const a = await make({ title: 'A' });
    const b = await make({ title: 'B' });
    unwrap(await globs.addSupersession(ADMIN, b.id, a.id, { reason: 'b replaces a' }, 'agent'));
    const cycle = await globs.addSupersession(ADMIN, a.id, b.id, { reason: 'a replaces b' }, 'agent');
    expect(message(cycle)).toContain('cycle');
    // Through a third glob.
    const c = await make({ title: 'C' });
    unwrap(await globs.addSupersession(ADMIN, c.id, b.id, { reason: 'c replaces b' }, 'agent'));
    expect(message(await globs.addSupersession(ADMIN, a.id, c.id, { reason: 'x' }, 'agent'))).toContain('cycle');
    expect(message(await globs.addSupersession(ADMIN, a.id, a.id, { reason: 'x' }, 'agent'))).toContain('itself');
    const d = await make({ title: 'D' });
    expect(message(await globs.addSupersession(ADMIN, d.id, a.id, {}, 'agent'))).toContain('needs a one-line reason');
    // Create-time: refused before anything is created.
    const count = store.state.globs.size;
    expect(message(await globs.createWithNotes(ADMIN, input({ supersedes: [a.id], by: 'agent' })))).toContain('needs a one-line reason');
    expect(store.state.globs.size).toBe(count);
  });

  it('a superseder on a board the actor cannot see answers like a missing glob; an uneditable superseded glob is refused', async () => {
    const OUTSIDER = 'outsider@example.com';
    await store.transaction((tx) => tx.upsertUser({ email: OUTSIDER, name: OUTSIDER, active: true }));
    const other = unwrap(await boards.create(OUTSIDER, { name: 'other', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }));
    const foreign = unwrap(await globs.create(OUTSIDER, input({ boardId: other.id })));
    const mine = await make();
    // The glob that would be marked superseded must be editable by the actor (membership), as for every write.
    expect(message(await globs.addSupersession(DEV, mine.id, foreign.id, { reason: 'x' }, 'agent'))).toBe('You are not a member of board 2');
    expect(message(await globs.addSupersession(DEV, foreign.id, mine.id, { reason: 'x' }, 'agent'))).toBe(`No glob ${foreign.id}`);
  });

  it('supersession rows never act as waits: not in unmet, start gates, relation lists or the cycle check', async () => {
    const a = await make({ title: 'A' });
    const b = await make({ type: 'sub', title: 'B' });
    expect(b.status).not.toBe('planning');
    unwrap(await globs.addSupersession(ADMIN, a.id, b.id, { reason: 'r' }, 'agent'));
    expect(supersessionRows()).toHaveLength(1);
    // Neither glob waits for the other.
    expect(unwrap(await globs.get(ADMIN, b.id)).waitingFor).toEqual([]);
    expect(unwrap(await globs.get(ADMIN, b.id)).holding).toEqual([]);
    expect(unwrap(await globs.get(ADMIN, b.id)).relations).toEqual([]);
    expect(await globs.peekRelations([b.id])).toEqual(new Map());
    expect(await globs.startHolds(b.id)).toEqual([]);
    // ... and a wait the other way round is no cycle.
    expect((await globs.addRelation(ADMIN, a.id, null, { to: b.id })).ok).toBe(true);
    // The board list does not carry the label as a relation either.
    const listed = unwrap(await globs.listWithArtifacts(ADMIN, boardId, {}));
    expect(listed.find((r) => r.glob.id === b.id)?.holding).toEqual([]);
  });

  it('a supersession across boards is stored on the superseded glob, redacted from a non-member', async () => {
    const other = unwrap(await boards.create(ADMIN, { name: 'other', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }));
    const old = unwrap(await globs.create(ADMIN, input({ boardId: other.id, title: 'Old on board two' })));
    const a = await make({ title: 'New on board one' });
    unwrap(await globs.addSupersession(ADMIN, a.id, old.id, { reason: 'r' }, 'agent'));
    expect(supersessionRows()).toMatchObject([{ boardId: other.id, from: old.id, to: a.id }]);
    // DEV is a member of board 1 only: A's view hides the glob on board 2.
    const view = unwrap(await globs.get(DEV, a.id));
    expect(view.relationGroups.supersedes).toMatchObject([{ id: 'another board', title: null, hidden: true, external: { boardId: other.id, hidden: true } }]);
    expect(JSON.stringify(view.relationGroups)).not.toContain(old.id);
  });
});
