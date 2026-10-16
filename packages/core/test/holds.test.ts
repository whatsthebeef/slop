import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import type { Glob, Relation } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const message = <T>(result: Result<T>): string => (result.ok ? '' : result.error.message);

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';

describe('holds: a follow-up or fix glob holds back the glob it serves', () => {
  let store: MemoryStore;
  let boards: BoardService;
  let globs: GlobService;
  let boardId: number;
  let runs: number;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Fix the rollout',
    type: 'same',
    category: 'bug',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const make = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrap(await globs.create(ADMIN, input(patch)));
  const merge = async (id: string): Promise<Glob> => unwrap(await globs.applyEvent(id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
  const rows = (from?: string): Relation[] => [...store.state.relations.values()].filter((r) => from === undefined || r.from === from);
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
    globs = new GlobService({ store, notifier, clock: { now: () => '2026-10-15T12:00:00.000Z' }, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('s14b6 -> s14t14: a fix for a failed rollout holds back sign-off of the glob it fixes (agent, with a reason)', async () => {
    const rollout = await make({ title: 'Log data protection', category: 'task' });
    await merge(rollout.id);
    const made = unwrap(
      await globs.createWithNotes(ADMIN, input({ holds: [{ id: rollout.id, reason: 'its rollout failed to provision: this fixes the stack' }], by: 'agent' })),
    );
    expect(made.notes.holds).toEqual([{ id: rollout.id, ok: true, why: 'added' }]);
    expect(rows(rollout.id)).toMatchObject([{ from: rollout.id, to: made.glob.id, gate: 'sign_off', until: 'merged', source: 'agent', reason: 'its rollout failed to provision: this fixes the stack' }]);
    // The existing glob is now held back by the new one, and says so in its view.
    const view = unwrap(await globs.get(ADMIN, rollout.id));
    expect(view.holding).toMatchObject([{ to: made.glob.id, gate: 'sign_off', state: 'planning' }]);
    expect(unwrap(await globs.get(ADMIN, made.glob.id)).relationGroups.holdsBack).toMatchObject([{ from: rollout.id, gate: 'sign_off' }]);
    // The version it returns is the one a next write carries.
    expect((await current(made.glob.id)).version).toBe(made.glob.version);
  });

  it('s14t19 -> s14t16: a continuation of a merged glob; a bare id takes the defaults for a person', async () => {
    const old = await make({ title: 'Old plan version', category: 'task' });
    await merge(old.id);
    const cont = unwrap(await globs.createWithNotes(ADMIN, input({ title: 'Finish it', category: 'task', holds: [old.id] })));
    expect(rows(old.id)).toMatchObject([{ to: cont.glob.id, gate: 'sign_off', until: 'merged', source: 'person', reason: null }]);
    // gate and until may be named; rolled_out is accepted.
    const other = await make({ title: 'Other', category: 'task' });
    unwrap(await globs.createWithNotes(ADMIN, input({ holds: [{ id: other.id, gate: 'merge', until: 'rolled_out', reason: 'x' }] })));
    expect(rows(other.id)[0]).toMatchObject({ gate: 'merge', until: 'merged' });
  });

  it('an agent must give a reason: a bad holds creates nothing', async () => {
    const x = await make({ category: 'task' });
    const before = [...store.state.globs.keys()].length;
    const refused = await globs.createWithNotes(ADMIN, input({ holds: [x.id], by: 'agent' }));
    expect(message(refused)).toContain(`Relation to ${x.id} needs a one-line reason`);
    expect([...store.state.globs.keys()].length).toBe(before);
    expect(rows()).toEqual([]);
  });

  it('refuses before creating: an unknown glob, a glob on a board the actor is not in, a cycle', async () => {
    const before = [...store.state.globs.keys()].length;
    expect(message(await globs.createWithNotes(ADMIN, input({ holds: ['s1t99'] })))).toBe('No glob s1t99');
    const other = unwrap(await boards.create(OUTSIDER, { name: 'other', repo: null, timeZone: 'UTC', environments: [] }));
    const foreign = unwrap(await globs.create(OUTSIDER, input({ boardId: other.id })));
    expect(message(await globs.createWithNotes(ADMIN, input({ holds: [foreign.id] })))).toBe(`No glob ${foreign.id}`);
    // The new glob waits for X and holds X back: a cycle.
    const x = await make({ category: 'task' });
    const cycle = await globs.createWithNotes(ADMIN, input({ after: [x.id], holds: [{ id: x.id, gate: 'start', reason: 'r' }] }));
    expect(message(cycle)).toContain('cycle');
    // ... also through another glob that waits for X.
    const y = await make({ category: 'task', after: [x.id] });
    const through = await globs.createWithNotes(ADMIN, input({ after: [y.id], holds: [{ id: x.id, gate: 'start', reason: 'r' }] }));
    expect(message(through)).toContain('cycle');
    expect([...store.state.globs.keys()].length).toBe(before + 3);
    expect(rows().filter((r) => r.source !== 'person')).toEqual([]);
  });

  it('a non-member of the board cannot create holds at all', async () => {
    const x = await make({ category: 'task' });
    expect(message(await globs.createWithNotes(OUTSIDER, input({ holds: [x.id] })))).toContain('not a member');
  });

  it('a retry with the same idempotency key adds nothing twice', async () => {
    const x = await make({ category: 'task' });
    await merge(x.id);
    const first = unwrap(await globs.createWithNotes(ADMIN, input({ idempotencyKey: 'k1', holds: [{ id: x.id, reason: 'fix' }], by: 'agent' })));
    const again = unwrap(await globs.createWithNotes(ADMIN, input({ idempotencyKey: 'k1', holds: [{ id: x.id, reason: 'fix' }], by: 'agent' })));
    expect(again.glob.id).toBe(first.glob.id);
    expect(again.notes.holds).toEqual([{ id: x.id, ok: true, why: 'added' }]);
    expect(rows(x.id)).toHaveLength(1);
    expect(store.state.events.filter((e) => e.type === 'RelationAdded' && e.globId === x.id)).toHaveLength(1);
  });

  it('holds across boards: the row lands on the other board\'s glob', async () => {
    const other = unwrap(await boards.create(ADMIN, { name: 'other', repo: null, timeZone: 'UTC', environments: [] }));
    const x = unwrap(await globs.create(ADMIN, input({ boardId: other.id, category: 'task' })));
    const made = unwrap(await globs.createWithNotes(ADMIN, input({ holds: [{ id: x.id, reason: 'a slop-side change it needs' }], by: 'agent' })));
    expect(rows(x.id)).toMatchObject([{ boardId: other.id, to: made.glob.id }]);
  });

  it('a glob created with holds closes the held glob\'s open step_failed suggestion', async () => {
    const x = await make({ category: 'task' });
    await merge(x.id);
    const step = unwrap(await globs.addHumanStep(ADMIN, x.id, null, { title: 'Provision the stack', kind: 'rollout' }));
    unwrap(await globs.failHumanStep(ADMIN, x.id, step.id, 'the stack did not provision', null));
    expect(unwrap(await globs.get(ADMIN, x.id)).suggestions).toMatchObject([{ kind: 'step_failed', stepId: step.id }]);
    unwrap(await globs.createWithNotes(ADMIN, input({ holds: [{ id: x.id, reason: 'fixes the provisioning' }], by: 'agent' })));
    expect(unwrap(await globs.get(ADMIN, x.id)).suggestions).toBeUndefined();
  });
});
