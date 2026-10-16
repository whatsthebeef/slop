import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import type { Glob } from '../src/domain/types.js';
import { isDismissedFor, mergeImplied } from '../src/domain/exclusive-paths.js';
import type { ToState } from '../src/domain/relations.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { ctx, dev, glob as fixture, relation, relationFacts } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';

describe('start relations', () => {
  let store: MemoryStore;
  let boards: BoardService;
  let globs: GlobService;
  let boardId: number;
  let runs: number;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Add a migration',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const create = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrap(await globs.create(ADMIN, input(patch)));
  const merge = async (id: string): Promise<Glob> =>
    unwrap(await globs.applyEvent(id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
  const kinds = (): string[] => store.state.outbox.map((e) => e.kind);
  /** The globs a glob starts after, from its relation rows. */
  const needsOf = (id: string): string[] => [...store.state.relations.values()].filter((r) => r.from === id && r.gate === 'start').map((r) => r.to);
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    runs = 0;
    boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => '2026-10-05T12:00:00.000Z' },
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(
      await boards.create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [] }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('holds a sub created with an unmerged after in Planning: no branch, no run', async () => {
    const first = await create();
    const second = await create({ type: 'sub', after: [first.id] });
    expect(second.status).toBe('planning');
    expect(needsOf(second.id)).toEqual([first.id]);
    expect(second.after).toBeUndefined();
    expect(second.waiting).not.toBeNull();
    expect(second.provisioning).toBe('none');
    expect(second.runs).toEqual([]);
    expect(kinds()).toEqual([]);
    expect(store.state.events.filter((e) => e.globId === second.id).map((e) => e.type)).toEqual(['GlobCreated', 'Waiting', 'RelationAdded', 'ArtifactAdded']);
    const view = unwrap(await globs.get(DEV, second.id));
    expect(view.waitingFor.map((w) => w.why)).toEqual([`Waits for ${first.id} to merge (it is in Planning)`]);
    expect(view.allowedActions).toContain('start_anyway');
    expect(unwrap(await globs.get(DEV, first.id)).waitedOnBy).toEqual([second.id]);
  });

  it('ignores an after that has already merged', async () => {
    const first = await create();
    await merge(first.id);
    const second = await create({ type: 'sub', after: [first.id] });
    expect(second.status).toBe('implementing');
    expect(needsOf(second.id)).toEqual([]);
    expect(second.runs).toHaveLength(1);
  });

  it('refuses unknown ids, ids on a board the actor is not a member of (the same answer) and a glob waiting for itself', async () => {
    const OUTSIDER = 'outsider@example.com';
    await store.transaction((tx) => tx.upsertUser({ email: OUTSIDER, name: OUTSIDER, active: true }));
    const other = unwrap(
      await boards.create(OUTSIDER, { name: 'other', repo: null, timeZone: 'UTC', environments: [] }),
    );
    const foreign = unwrap(await globs.create(OUTSIDER, input({ boardId: other.id })));
    const unknown = await globs.create(ADMIN, input({ type: 'sub', after: ['s99t99'] }));
    expect(!unknown.ok && unknown.error.code).toBe('invalid_input');
    const wrongBoard = await globs.create(ADMIN, input({ type: 'sub', after: [foreign.id] }));
    expect(!wrongBoard.ok && wrongBoard.error.code).toBe('invalid_input');
    expect(!wrongBoard.ok && wrongBoard.error.message).toBe(`No glob ${foreign.id}`);
    const mine = await create();
    const self = await globs.update(DEV, mine.id, mine.version, { after: [mine.id] });
    expect(!self.ok && self.error.message).toContain('itself');
  });

  it('refuses a cycle', async () => {
    const a = await create();
    const b = await create({ type: 'sub', after: [a.id] });
    const result = await globs.update(DEV, a.id, a.version, { after: [b.id] });
    expect(!result.ok && result.error.code).toBe('invalid_input');
    expect(!result.ok && result.error.message).toContain('already waits for');
    // A longer chain too.
    const c = await create({ type: 'sub', after: [b.id] });
    const longer = await globs.update(DEV, a.id, a.version, { after: [c.id] });
    expect(longer.ok).toBe(false);
  });

  it('a same changed to a sub waits when its after is unmerged, and runs when it is not', async () => {
    const first = await create();
    const second = await create({ after: [first.id] });
    expect(second.status).toBe('planning');
    expect(second.waiting == null).toBe(true);
    const changed = unwrap(await globs.update(ADMIN, second.id, second.version, { type: 'sub' }));
    expect(changed.status).toBe('planning');
    expect(changed.waiting).not.toBeNull();
    expect(changed.runs).toEqual([]);
    expect(kinds()).toEqual([]);

    const free = await create();
    const run = unwrap(await globs.update(ADMIN, free.id, free.version, { type: 'sub' }));
    expect(run.status).toBe('implementing');
    expect(run.runs).toHaveLength(1);
  });

  it('the board list offers the same actions as a single read for a same held only by `after`', async () => {
    const first = await create();
    const second = await create({ after: [first.id] });
    const listed = unwrap(await globs.listWithArtifacts(DEV, second.boardId, {}));
    const row = listed.find((r) => r.glob.id === second.id);
    const fromList = machine.allowedActions(second, { email: DEV, role: 'dev' }, { relations: row?.relations });
    expect(fromList).toContain('start_anyway');
    expect(fromList).not.toContain('start');
    expect(fromList).toEqual(unwrap(await globs.get(DEV, second.id)).allowedActions);
  });

  it('refuses Start on a same while it waits; Start now goes ahead', async () => {
    const first = await create();
    const second = await create({ after: [first.id] });
    const refused = await globs.start(DEV, second.id, second.version);
    expect(!refused.ok && refused.error.code).toBe('invalid_transition');
    expect(!refused.ok && refused.error.message).toBe(`Waits for ${first.id} to merge (it is in Planning) (use Start now)`);
    const view = unwrap(await globs.get(DEV, second.id));
    expect(view.allowedActions).not.toContain('start');
    expect(view.allowedActions).toContain('start_anyway');
    const started = unwrap(await globs.startAnyway(DEV, second.id, second.version));
    expect(started.status).toBe('implementing');
    expect(started.runs).toHaveLength(1);
    expect(store.state.events.some((e) => e.globId === second.id && e.type === 'HoldOverridden')).toBe(true);
  });

  it('a person can pick up a waiting glob, with a warning naming what has not merged', async () => {
    const first = await create();
    const second = await create({ type: 'sub', after: [first.id] });
    const picked = unwrap(await globs.pickUpWithWarning(DEV, second.id, second.version, false));
    expect(picked.glob.status).toBe('in_progress');
    expect(picked.glob.waiting).toBeNull();
    expect(picked.warning).toContain(`${first.id} hasn't merged yet`);
    const pickedEvent = store.state.events.find((e) => e.globId === second.id && e.type === 'PickedUp');
    expect(pickedEvent?.data).toMatchObject({ waitingFor: [first.id] });
  });

  it('releases a waiting sub when what it waits for merges, through the outbox, from the current main', async () => {
    const first = await create();
    const second = await create({ type: 'sub', after: [first.id] });
    await merge(first.id);
    expect(kinds()).toContain('release_waiting');
    const effect = store.state.outbox.find((e) => e.kind === 'release_waiting');
    expect(effect).toMatchObject({ globId: first.id });
    const before = store.state.outbox.length;

    expect(await globs.releaseDependents(first.id, boardId)).toEqual([second.id]);
    const released = await current(second.id);
    expect(released.status).toBe('implementing');
    expect(released.waiting).toBeNull();
    expect(released.provisioning).toBe('pending');
    expect(released.runs).toHaveLength(1);
    expect(released.runs[0]?.triggeredBy).toBe(ADMIN);
    expect(store.state.outbox.slice(before).map((e) => e.kind)).toEqual(['provision', 'fire_routine']);
    expect(store.state.events.filter((e) => e.globId === second.id).map((e) => e.type)).toContain('Released');
  });

  it('releases only when every dependency has merged', async () => {
    const a = await create();
    const b = await create();
    const waiter = await create({ type: 'sub', after: [a.id, b.id] });
    await merge(a.id);
    expect(await globs.releaseDependents(a.id, boardId)).toEqual([]);
    expect((await current(waiter.id)).status).toBe('planning');
    await merge(b.id);
    expect(await globs.releaseDependents(b.id, boardId)).toEqual([waiter.id]);
    expect((await current(waiter.id)).status).toBe('implementing');
  });

  it('release is idempotent: a second delivery starts nothing more', async () => {
    const first = await create();
    const second = await create({ type: 'sub', after: [first.id] });
    await merge(first.id);
    await globs.releaseDependents(first.id, boardId);
    const outbox = store.state.outbox.length;
    const once = await current(second.id);
    expect(await globs.releaseDependents(first.id, boardId)).toEqual([]);
    expect((await globs.release(second.id)).ok).toBe(true);
    expect(await current(second.id)).toEqual(once);
    expect(store.state.outbox).toHaveLength(outbox);
    expect((await current(second.id)).runs).toHaveLength(1);
  });

  it('releases a same that was created to start automatically', async () => {
    const first = await create();
    const second = await create({ autoTrigger: true, after: [first.id] });
    expect(second.status).toBe('planning');
    expect(second.waiting).not.toBeNull();
    await merge(first.id);
    await globs.releaseDependents(first.id, boardId);
    expect((await current(second.id)).status).toBe('implementing');
  });

  it('keeps a held same waiting through an unrelated edit', async () => {
    const first = await create();
    const second = await create({ autoTrigger: true, after: [first.id] });
    expect(second.waiting).not.toBeNull();
    const edited = unwrap(await globs.update(DEV, second.id, second.version, { title: 'A new title' }));
    expect(edited.title).toBe('A new title');
    expect(edited.status).toBe('planning');
    expect(edited.waiting).not.toBeNull();
    await merge(first.id);
    await globs.releaseDependents(first.id, boardId);
    expect((await current(second.id)).status).toBe('implementing');
  });

  it('releases a held same when its after is emptied', async () => {
    const first = await create();
    const second = await create({ autoTrigger: true, after: [first.id] });
    expect(second.waiting).not.toBeNull();
    const released = unwrap(await globs.update(DEV, second.id, second.version, { after: [] }));
    expect(released.status).toBe('implementing');
    expect(released.waiting).toBeNull();
    expect(released.runs).toHaveLength(1);
  });

  it('does not start a same that only has an after stored', async () => {
    const first = await create();
    const second = await create({ after: [first.id] });
    await merge(first.id);
    expect(await globs.releaseDependents(first.id, boardId)).toEqual([]);
    expect((await current(second.id)).status).toBe('planning');
    // Its Start now works.
    expect(unwrap(await globs.start(DEV, second.id, second.version)).status).toBe('implementing');
  });

  it('releases a glob when what it waits for is deleted, with a note, and keeps the row', async () => {
    const first = await create();
    const second = await create({ type: 'sub', after: [first.id] });
    const other = await create();
    const third = await create({ type: 'sub', after: [first.id, other.id] });
    unwrap(await globs.delete(DEV, first.id, first.version));
    // The one held only by the deleted glob starts; the one that also waits for another stays put.
    expect((await current(second.id)).status).toBe('implementing');
    expect((await current(second.id)).waiting).toBeNull();
    const view = unwrap(await globs.get(DEV, third.id));
    expect(view.glob.status).toBe('planning');
    expect(view.waitingFor.map((w) => w.id)).toEqual([other.id]);
    const released = store.state.events.filter((e) => e.globId === second.id && e.type === 'RelationReleased');
    expect(released.map((e) => e.data)).toEqual([{ to: first.id, gate: 'start', reason: `${first.id} was deleted` }]);
    expect(store.state.events.filter((e) => e.globId === second.id).map((e) => e.type)).toContain('Released');
    // Its version moved with the change, and the row stays so a view can say the other glob was deleted.
    expect(needsOf(second.id)).toEqual([first.id]);
    expect(second.version).toBeLessThan((await current(second.id)).version);
    // A glob's own rows go with it.
    unwrap(await globs.delete(DEV, third.id, view.glob.version));
    expect(needsOf(third.id)).toEqual([]);
  });

  it('keeps a glob put when what it waits for goes back to Planning', async () => {
    const first = await create();
    const second = await create({ type: 'sub', after: [first.id] });
    const started = unwrap(await globs.start(DEV, first.id, first.version));
    expect((await globs.release(second.id)).ok).toBe(true);
    expect((await current(second.id)).status).toBe('planning');
    const back = unwrap(await globs.startAgain(DEV, started.id, started.version));
    expect(back.status).toBe('planning');
    const view = unwrap(await globs.get(DEV, second.id));
    expect(view.waitingFor[0]?.state).toBe('planning');
    expect((await globs.release(second.id)).ok).toBe(true);
    expect((await current(second.id)).status).toBe('planning');
  });

  it('puts a started sub with an unmerged after back on hold when it starts again', async () => {
    const first = await create();
    const second = await create({ type: 'sub', after: [first.id] });
    const picked = unwrap(await globs.pickUp(DEV, second.id, second.version, false));
    const again = unwrap(await globs.startAgain(DEV, picked.id, picked.version));
    expect(again.status).toBe('planning');
    expect(again.waiting).not.toBeNull();
    expect(again.provisioning).toBe('none');
  });

  it('refuses to edit after once the glob has started', async () => {
    const first = await create();
    const second = await create({ type: 'sub' });
    expect(second.status).toBe('implementing');
    const result = await globs.update(DEV, second.id, second.version, { after: [first.id] });
    expect(!result.ok && result.error.code).toBe('invalid_transition');
    // Same value: nothing to refuse.
    expect((await globs.update(DEV, second.id, second.version, { after: [] })).ok).toBe(true);
  });

  describe('dismissing an edge', () => {
    /** Records an inferred need of `glob` on `to`, as inference would have written it. */
    const infer = (glob: Glob, to: string) => {
      const row = relation(glob.id, to, { source: 'inferred', reason: 'it adds the endpoint this uses' });
      store.state.relations.set(row.id, row);
      return row;
    };

    it('dismisses a recorded relation with the plan hash, logs RelationDismissed and unblocks a sub that waited only for it', async () => {
      const first = await create();
      const sub = await create({ type: 'sub' });
      // A sub waiting only for an inferred relation: held in Planning.
      const waiting = { ...(await current(sub.id)), status: 'planning' as const, provisioning: 'none' as const, runs: [], waiting: { since: 'x' } };
      store.state.globs.set(sub.id, { glob: waiting, creationKey: null });
      const row = infer(waiting, first.id);
      expect(unwrap(await globs.get(DEV, waiting.id)).waitingFor.map((w) => w.id)).toEqual([first.id]);

      const dismissed = unwrap(await globs.dismissRelation(DEV, waiting.id, waiting.version, row.id));
      expect(dismissed.status).toBe('implementing');
      expect(dismissed.runs).toHaveLength(1);
      const stored = store.state.relations.get(row.id);
      expect(stored?.dismissedAt).not.toBeNull();
      expect(stored?.dismissedPlanHash).toMatch(/^[0-9a-f]+$/);
      expect(stored?.overriddenAt).toBeNull();
      const event = store.state.events.find((e) => e.globId === waiting.id && e.type === 'RelationDismissed');
      expect(event?.data).toMatchObject({ to: first.id, edgeId: first.id, gate: 'start', source: 'inferred', planHash: stored?.dismissedPlanHash });
      expect(store.state.events.some((e) => e.globId === waiting.id && e.type === 'HoldOverridden')).toBe(false);
    });

    it('refuses a stale version and an unknown relation; an old split relation, like a person-set one, can be dismissed; a repeat changes nothing', async () => {
      const first = await create();
      const other = await create();
      const second = await create({ after: [first.id] });
      const row = infer(second, other.id);
      const stale = await globs.dismissRelation(DEV, second.id, second.version + 1, row.id);
      expect(!stale.ok && stale.error.code).toBe('version_conflict');
      const unknown = await globs.dismissRelation(DEV, second.id, second.version, 'rel_nope');
      expect(!unknown.ok && unknown.error.code).toBe('invalid_input');
      const split = relation(second.id, other.id, { gate: 'sign_off', source: 'split' });
      store.state.relations.set(split.id, split);
      const oldSplit = unwrap(await globs.dismissRelation(DEV, second.id, second.version, split.id));
      expect(oldSplit.version).toBe(second.version + 1);
      const once = unwrap(await globs.dismissRelation(DEV, second.id, oldSplit.version, row.id));
      expect(once.version).toBe(oldSplit.version + 1);
      const twice = unwrap(await globs.dismissRelation(DEV, second.id, once.version, row.id));
      expect(twice.version).toBe(once.version);
      expect(store.state.events.filter((e) => e.type === 'RelationDismissed')).toHaveLength(2);
      // The person's own relation can be dismissed too (the ✕ on a relation they added).
      const mine = [...store.state.relations.values()].find((r) => r.from === second.id && r.to === first.id);
      expect(unwrap(await globs.dismissRelation(DEV, second.id, once.version, mine?.id ?? '')).version).toBe(once.version + 1);
    });
  });

  // Bug 1: a start relation to a target that merged was dropped even when its rollout still held its dependants.
  describe('a relation to a target that merged', () => {
    /** The target: merged, with an open rollout step that holds its dependants (state `rollout`). */
    const rollingOut = async (): Promise<Glob> => {
      const target = await create();
      await merge(target.id);
      unwrap(await globs.addHumanStep(ADMIN, target.id, null, { title: 'Turn it on', kind: 'rollout', blocks: ['sign_off', 'dependants'] }));
      return target;
    };
    /** The target: merged and fully rolled out (no open step), so nothing is left to wait for. */
    const rolledOut = async (): Promise<Glob> => {
      const target = await create();
      await merge(target.id);
      return target;
    };
    const modes: readonly [string, (to: string) => Partial<CreateGlobInput>][] = [
      ['an explicit sub with after', (to) => ({ type: 'sub', after: [to] })],
      ['an untyped create (the type was not chosen) with after', (to) => ({ type: 'sub', typeChosen: false, after: [to] })],
      ['a start relation in relations (needs)', (to) => ({ type: 'sub', relations: [{ to, gate: 'start' }] })],
      [
        'an input-only (intake) create with after',
        (to) => ({
          type: 'sub',
          typeChosen: false,
          plan: null,
          title: 'Add a column',
          after: [to],
          intake: { request: 'Add a column', source: 'web', categoryConfidence: null, reason: null, model: null, promptVersion: null, examples: [] },
        }),
      ],
    ];

    for (const [name, patch] of modes) {
      it(`${name}: an unmerged target holds the glob in Planning with no run`, async () => {
        const target = await create();
        const waiter = await create(patch(target.id));
        expect(needsOf(waiter.id)).toEqual([target.id]);
        expect(waiter.status).toBe('planning');
        expect(waiter.waiting).not.toBeNull();
        expect(waiter.runs).toEqual([]);
      });

      it(`${name}: a target merged with an open rollout step keeps the relation and the glob waits`, async () => {
        const target = await rollingOut();
        const waiter = await create(patch(target.id));
        expect(needsOf(waiter.id)).toEqual([target.id]);
        expect(waiter.status).toBe('planning');
        expect(waiter.waiting).not.toBeNull();
        expect(waiter.runs).toEqual([]);
        expect(kinds()).not.toContain('fire_routine');
        const view = unwrap(await globs.get(DEV, waiter.id));
        expect(view.waitingFor.map((w) => w.state)).toEqual(['rollout']);
        expect(view.waitingFor[0]?.why).toContain('rollout');
      });

      it(`${name}: a target merged and rolled out holds nothing and is not recorded`, async () => {
        const target = await rolledOut();
        const waiter = await create(patch(target.id));
        expect(needsOf(waiter.id)).toEqual([]);
        expect(waiter.status).not.toBe('planning');
        expect(waiter.runs).toHaveLength(1);
      });
    }

    it('createWithNotes reports the ignored target and why, and keeps the one that holds', async () => {
      const done = await rolledOut();
      const rolling = await rollingOut();
      const created = unwrap(await globs.createWithNotes(ADMIN, input({ type: 'sub', after: [done.id, rolling.id] })));
      expect(needsOf(created.glob.id)).toEqual([rolling.id]);
      expect(created.notes.ignoredAfter).toEqual([{ id: done.id, why: `${done.id} is merged and rolled out` }]);
      expect(created.notes.holds).toEqual([]);
      expect(created.notes.typeNote).toBeNull();
    });

    it('createWithNotes says when a non-admin untyped create became a same, and keeps its relation', async () => {
      const target = await create();
      const made = unwrap(await globs.createWithNotes(DEV, input({ type: 'sub', typeChosen: false, after: [target.id] })));
      expect(made.glob.type).toBe('same');
      expect(made.notes.typeNote).toContain('same');
      expect(needsOf(made.glob.id)).toEqual([target.id]);
    });

    it('an action keeps a relation to a target whose rollout is open, and drops one that is rolled out', async () => {
      const rolling = await rollingOut();
      const done = await rolledOut();
      const action = unwrap(await globs.create(ADMIN, input({ category: 'action', type: null, title: 'Do it', after: [rolling.id, done.id] })));
      expect(needsOf(action.id)).toEqual([rolling.id]);
    });

    it('update after keeps a rollout-held target and drops a rolled-out one', async () => {
      const rolling = await rollingOut();
      const done = await rolledOut();
      const g = await create();
      const updated = unwrap(await globs.update(DEV, g.id, g.version, { after: [rolling.id, done.id] }));
      expect(updated.version).toBeGreaterThan(g.version);
      expect(needsOf(g.id)).toEqual([rolling.id]);
    });

    it('a rollout-held target releases the waiter once its rollout step is done', async () => {
      const target = await rollingOut();
      const waiter = await create({ type: 'sub', after: [target.id] });
      const step = [...store.state.humanSteps.values()].find((s) => s.globId === target.id);
      expect((await current(waiter.id)).status).toBe('planning');
      unwrap(await globs.completeHumanStep(ADMIN, target.id, step?.id ?? '', null));
      // Closing the last step releases what waited for the rollout.
      expect((await current(waiter.id)).status).toBe('implementing');
    });
  });
});

describe('dismissals (pure)', () => {
  it('a dismissal suppresses re-inference only while the plan hash is unchanged', () => {
    const edge = { id: 's1t2', paths: [], kind: 'needs' as const, source: 'inferred' as const, overridden: true as const, dismissedPlanHash: 'h1' };
    expect(isDismissedFor(edge, 'h1')).toBe(true);
    expect(isDismissedFor(edge, 'h2')).toBe(false);
    expect(isDismissedFor({ ...edge, dismissedPlanHash: undefined }, 'h1')).toBe(false);
    const fresh = { id: 's1t2', paths: [], kind: 'needs' as const, source: 'inferred' as const };
    expect(mergeImplied([edge], [fresh])).toEqual([edge]);
  });
});

describe('waiting transitions', () => {
  /** The held glob's start relations to the given globs, with the state of each. */
  const states = (entries: [string, ToState][]) => relationFacts('s1t1', entries);

  it('only the final merge queues release_waiting, not Merge and continue', () => {
    const plain = machine.merged(fixture({ status: 'pr_open', type: 'same' }), { sha: 'abc1234' }, ctx(null));
    expect(plain.ok && plain.value.effects.map((e) => e.kind)).toContain('release_waiting');
    expect(plain.ok && plain.value.effects).toContainEqual({ kind: 'check_rollout_paths', globId: 's1t1', generation: 1, sha: 'abc1234' });
    const keepGoing = machine.merged(
      fixture({ status: 'merging', type: 'super', mergeMode: 'continue' }),
      { sha: 'abc1234', number: 7 },
      ctx(null),
    );
    expect(keepGoing.ok && keepGoing.value.effects.map((e) => e.kind)).not.toContain('release_waiting');
    expect(keepGoing.ok && keepGoing.value.effects.map((e) => e.kind)).not.toContain('check_rollout_paths');
  });

  it('released does nothing for a glob that is not held, or still waits', () => {
    const open = states([['s1t2', 'open']]);
    const free = machine.released(fixture({ type: 'sub', status: 'planning' }), ctx(null), open);
    expect(free.ok && free.value.changed).toBe(false);
    const held = fixture({ type: 'sub', status: 'planning', provisioning: 'none', waiting: { since: 'x' } });
    const still = machine.released(held, ctx(null), open);
    expect(still.ok && still.value.changed).toBe(false);
    const go = machine.released(held, ctx(null), states([['s1t2', 'merged']]));
    expect(go.ok && go.value.glob.status).toBe('implementing');
    expect(go.ok && go.value.effects.map((e) => e.kind)).toEqual(['provision', 'fire_routine']);
  });

  it('allowedActions hides Start and offers Start now for a held same', () => {
    const held = fixture({ type: 'same', status: 'planning' });
    const open = states([['s1t2', 'open']]);
    const actions = machine.allowedActions(held, dev, { relations: open });
    expect(actions).toContain('start_anyway');
    expect(actions).not.toContain('start');
    expect(actions).toContain('pick_up');
    const merged = machine.allowedActions(held, dev, { relations: states([['s1t2', 'merged']]) });
    expect(merged).toContain('start');
    expect(merged).not.toContain('start_anyway');
  });
});

describe('Retrigger and the routine fire with prerequisites unmerged', () => {
  const failed = fixture({ status: 'failed' });
  const unmerged = relationFacts('s1t3', [['s1t1', 'planning']]);

  it('refuses Retrigger with what it waits for as the reason, and goes ahead anyway without a check on the fire', () => {
    const refused = machine.retrigger(failed, ctx(dev), unmerged);
    expect(!refused.ok && refused.error.message).toBe('Waits for s1t1 to merge (it is in Planning) (use Start now)');
    const anyway = machine.retrigger(failed, ctx(dev), unmerged, true);
    expect(anyway.ok && anyway.value.effects.find((e) => e.kind === 'fire_routine')).not.toHaveProperty('checkPrerequisites');
  });

  it('marks the fire of a plain Retrigger or Start to be checked, and Start now not', () => {
    const retriggered = machine.retrigger(fixture({ status: 'failed' }), ctx(dev));
    expect(retriggered.ok && retriggered.value.effects.find((e) => e.kind === 'fire_routine')).toHaveProperty('checkPrerequisites', true);
    const start = machine.start(fixture({ status: 'planning', type: 'same' }), ctx(dev));
    expect(start.ok && start.value.effects.find((e) => e.kind === 'fire_routine')).toHaveProperty('checkPrerequisites', true);
    const anyway = machine.startAnyway(fixture({ status: 'planning', type: 'same' }), ctx(dev), relationFacts('s1t1', [['s1t1', 'planning']]));
    expect(anyway.ok && anyway.value.effects.find((e) => e.kind === 'fire_routine')).not.toHaveProperty('checkPrerequisites');
  });
});
