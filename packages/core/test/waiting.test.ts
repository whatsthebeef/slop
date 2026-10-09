import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import type { Glob } from '../src/domain/types.js';
import { checkAfter, dependencyState, waitingFor } from '../src/domain/waiting.js';
import type { DependencyState } from '../src/domain/waiting.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { ctx, dev, glob as fixture } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';

describe('start after', () => {
  let store: MemoryStore;
  let boards: BoardService;
  let globs: GlobService;
  let boardId: number;
  let runs: number;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Add a migration',
    summary: '',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const create = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrap(await globs.create(DEV, input(patch)));
  const merge = async (id: string): Promise<Glob> =>
    unwrap(await globs.applyEvent(id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
  const kinds = (): string[] => store.state.outbox.map((e) => e.kind);
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
      await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }),
    ).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('holds a sub created with an unmerged after in Planning: no branch, no run', async () => {
    const first = await create();
    const second = await create({ type: 'sub', after: [first.id] });
    expect(second.status).toBe('planning');
    expect(second.after).toEqual([first.id]);
    expect(second.waiting).not.toBeNull();
    expect(second.provisioning).toBe('none');
    expect(second.runs).toEqual([]);
    expect(kinds()).toEqual([]);
    expect(store.state.events.filter((e) => e.globId === second.id).map((e) => e.type)).toEqual(['GlobCreated', 'Waiting']);
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
    expect(second.after).toBeUndefined();
    expect(second.runs).toHaveLength(1);
  });

  it('refuses unknown ids, ids on another board and a glob waiting for itself', async () => {
    const other = unwrap(
      await boards.create(ADMIN, { name: 'other', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }),
    );
    unwrap(await boards.setMember(ADMIN, other.id, DEV, 'dev'));
    const foreign = unwrap(await globs.create(DEV, input({ boardId: other.id })));
    const unknown = await globs.create(DEV, input({ type: 'sub', after: ['s99t99'] }));
    expect(!unknown.ok && unknown.error.code).toBe('invalid_input');
    const wrongBoard = await globs.create(DEV, input({ type: 'sub', after: [foreign.id] }));
    expect(!wrongBoard.ok && wrongBoard.error.message).toContain('on this board');
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
    const changed = unwrap(await globs.update(DEV, second.id, second.version, { type: 'sub' }));
    expect(changed.status).toBe('planning');
    expect(changed.waiting).not.toBeNull();
    expect(changed.runs).toEqual([]);
    expect(kinds()).toEqual([]);

    const free = await create();
    const run = unwrap(await globs.update(DEV, free.id, free.version, { type: 'sub' }));
    expect(run.status).toBe('implementing');
    expect(run.runs).toHaveLength(1);
  });

  it('the board list offers the same actions as a single read for a same held only by `after`', async () => {
    const first = await create();
    const second = await create({ after: [first.id] });
    const listed = unwrap(await globs.listWithArtifacts(DEV, second.boardId, {}));
    const row = listed.find((r) => r.glob.id === second.id);
    const fromList = machine.allowedActions(second, { email: DEV, role: 'dev' }, { dependencies: row?.dependencies });
    expect(fromList).toContain('start_anyway');
    expect(fromList).not.toContain('start');
    expect(fromList).toEqual(unwrap(await globs.get(DEV, second.id)).allowedActions);
  });

  it('refuses Start on a same while it waits; Start anyway goes ahead', async () => {
    const first = await create();
    const second = await create({ after: [first.id] });
    const refused = await globs.start(DEV, second.id, second.version);
    expect(!refused.ok && refused.error.code).toBe('invalid_transition');
    expect(!refused.ok && refused.error.message).toContain(`Waits for ${first.id} to merge`);
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
    expect(released.runs[0]?.triggeredBy).toBe(DEV);
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

  it('keeps a glob put when what it waits for is deleted, and says so', async () => {
    const first = await create();
    const second = await create({ type: 'sub', after: [first.id] });
    unwrap(await globs.delete(DEV, first.id, first.version));
    expect(await globs.releaseDependents(first.id, boardId)).toEqual([]);
    const view = unwrap(await globs.get(DEV, second.id));
    expect(view.glob.status).toBe('planning');
    expect(view.waitingFor.map((w) => w.why)).toEqual([`Waits for ${first.id}, which was deleted`]);
    // A person edits the list to let it go.
    const freed = unwrap(await globs.update(DEV, second.id, view.glob.version, { after: [] }));
    expect(freed.status).toBe('implementing');
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
});

describe('waiting (pure)', () => {
  it('reads each dependency state from the glob', () => {
    expect(dependencyState(null)).toBe('missing');
    expect(dependencyState(fixture({ status: 'reviewing' }))).toBe('merged');
    expect(dependencyState(fixture({ status: 'signed_off' }))).toBe('merged');
    expect(dependencyState(fixture({ status: 'planning' }))).toBe('planning');
    expect(dependencyState(fixture({ status: 'pr_open' }))).toBe('open');
    // A super that merged and continues is still open.
    expect(dependencyState(fixture({ status: 'in_progress', type: 'super', prs: [{ number: 1, mergeSha: 'a', mergedAt: '' }] }))).toBe('open');
  });

  it('lists only what has not merged; an unknown id reads as deleted', () => {
    const states = new Map<string, DependencyState>([
      ['s1t1', 'merged'],
      ['s1t2', 'open'],
    ]);
    const awaited = waitingFor({ after: ['s1t1', 's1t2', 's1t3'] }, states);
    expect(awaited.map((a) => [a.id, a.state])).toEqual([
      ['s1t2', 'open'],
      ['s1t3', 'missing'],
    ]);
  });

  it('words an implied hold with its paths', () => {
    const states = new Map<string, DependencyState>([['s1t2', 'open']]);
    const [first] = waitingFor({ impliedAfter: [{ id: 's1t2', paths: ['apps/server/drizzle/0001.sql'] }] }, states);
    expect(first?.why).toBe('Waits for s1t2: both may change apps/server/drizzle/0001.sql');
  });

  it('checkAfter drops merged ids, de-duplicates and caps the list', () => {
    const globs = new Map([
      ['s1t1', fixture({ id: 's1t1', status: 'reviewing' })],
      ['s1t2', fixture({ id: 's1t2', status: 'implementing' })],
    ]);
    const checked = checkAfter('s1t9', ['s1t1', 's1t2', 's1t2', ' '], 1, (id) => globs.get(id));
    expect(checked.ok && checked.value).toEqual(['s1t2']);
    const many = Array.from({ length: 21 }, (_, i) => `s1t${String(i + 100)}`);
    expect(checkAfter(null, many, 1, () => undefined).ok).toBe(false);
  });
});

describe('waiting transitions', () => {
  const states = (entries: [string, DependencyState][]) => new Map(entries);

  it('only the final merge queues release_waiting, not Merge and continue', () => {
    const plain = machine.merged(fixture({ status: 'pr_open', type: 'same' }), { sha: 'abc1234' }, ctx(null));
    expect(plain.ok && plain.value.effects.map((e) => e.kind)).toContain('release_waiting');
    const keepGoing = machine.merged(
      fixture({ status: 'merging', type: 'super', mergeMode: 'continue' }),
      { sha: 'abc1234', number: 7 },
      ctx(null),
    );
    expect(keepGoing.ok && keepGoing.value.effects.map((e) => e.kind)).not.toContain('release_waiting');
  });

  it('released does nothing for a glob that is not held, or still waits', () => {
    const open = states([['s1t2', 'open']]);
    const free = machine.released(fixture({ type: 'sub', status: 'planning' }), ctx(null), open);
    expect(free.ok && free.value.changed).toBe(false);
    const held = fixture({ type: 'sub', status: 'planning', provisioning: 'none', after: ['s1t2'], waiting: { since: 'x' } });
    const still = machine.released(held, ctx(null), open);
    expect(still.ok && still.value.changed).toBe(false);
    const go = machine.released(held, ctx(null), states([['s1t2', 'merged']]));
    expect(go.ok && go.value.glob.status).toBe('implementing');
    expect(go.ok && go.value.effects.map((e) => e.kind)).toEqual(['provision', 'fire_routine']);
  });

  it('allowedActions hides Start and offers Start anyway for a held same', () => {
    const held = fixture({ type: 'same', status: 'planning', after: ['s1t2'] });
    const open = states([['s1t2', 'open']]);
    const actions = machine.allowedActions(held, dev, { dependencies: open });
    expect(actions).toContain('start_anyway');
    expect(actions).not.toContain('start');
    expect(actions).toContain('pick_up');
    const merged = machine.allowedActions(held, dev, { dependencies: states([['s1t2', 'merged']]) });
    expect(merged).toContain('start');
    expect(merged).not.toContain('start_anyway');
  });
});
