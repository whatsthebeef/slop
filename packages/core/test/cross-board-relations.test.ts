import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService, OTHER_BOARD } from '../src/app/glob-service.js';
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

const BOTH = 'both@example.com'; // admin of both boards
const ONE = 'one@example.com'; // member of board 1 only
const TWO = 'two@example.com'; // member of board 2 only
const NOBODY = 'nobody@example.com';

describe('cross-board relations', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let boards: BoardService;
  let globs: GlobService;
  let b1: number;
  let b2: number;
  let runs: number;

  const input = (boardId: number, patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
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
  const make = async (boardId: number, patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrap(await globs.create(BOTH, input(boardId, patch)));
  const merge = async (id: string): Promise<Glob> => unwrap(await globs.applyEvent(id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  const rows = (from?: string): Relation[] => [...store.state.relations.values()].filter((r) => from === undefined || r.from === from);
  /** A merged glob with an open rollout step that holds its dependants. */
  const rollingOut = async (boardId: number): Promise<{ glob: Glob; step: string }> => {
    const glob = await make(boardId);
    await merge(glob.id);
    const step = unwrap(await globs.addHumanStep(BOTH, glob.id, null, { title: 'Turn it on', kind: 'rollout', blocks: ['sign_off', 'dependants'] }));
    return { glob, step: step.id };
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    runs = 0;
    boards = new BoardService({ store, notifier });
    globs = new GlobService({ store, notifier, clock: { now: () => '2026-10-15T12:00:00.000Z' }, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction(async (tx) => {
      for (const email of [BOTH, ONE, TWO, NOBODY]) await tx.upsertUser({ email, name: email, active: true });
    });
    b1 = unwrap(await boards.create(BOTH, { name: 'Board one', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    b2 = unwrap(await boards.create(BOTH, { name: 'Board two', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(BOTH, b1, ONE, 'dev'));
    unwrap(await boards.setMember(BOTH, b2, TWO, 'dev'));
  });

  it('a glob waits for a glob on another board: the row is stored on the holder, and the target is hinted', async () => {
    const target = await make(b2);
    const holder = await make(b1, { type: 'sub', after: [target.id] });
    expect(holder.status).toBe('planning');
    expect(holder.waiting).not.toBeNull();
    expect(rows(holder.id)).toMatchObject([{ boardId: b1, to: target.id, gate: 'start', until: 'merged', source: 'person' }]);
    expect(notifier.hints.some((h) => h.kind === 'glob.changed' && h.globId === target.id)).toBe(true);
    // The same gates work through add_relation and update.
    const other = await make(b1);
    unwrap(await globs.addRelation(BOTH, other.id, null, { to: target.id, gate: 'sign_off', reason: 'ships with it' }, 'held_by', 'agent'));
    expect(rows(other.id)[0]).toMatchObject({ to: target.id, gate: 'sign_off', source: 'agent' });
  });

  it('refuses a target on a board the actor is not a member of, with the answer for a glob that does not exist', async () => {
    const target = await make(b2);
    const mine = await make(b1);
    const real = await globs.addRelation(ONE, mine.id, null, { to: target.id }, 'held_by', 'person');
    const missing = await globs.addRelation(ONE, mine.id, null, { to: 's2t99' }, 'held_by', 'person');
    expect(real.ok).toBe(false);
    expect(message(real)).toBe(`No glob ${target.id}`);
    expect(message(missing)).toBe('No glob s2t99');
    expect(!real.ok && real.error.code).toBe(!missing.ok && missing.error.code);
    // create and update answer the same way.
    const created = await globs.create(ONE, input(b1, { after: [target.id] }));
    expect(message(created)).toBe(`No glob ${target.id}`);
    const updated = await globs.update(ONE, mine.id, mine.version, { after: [target.id] });
    expect(message(updated)).toBe(`No glob ${target.id}`);
    expect(rows()).toEqual([]);
    // A member of both boards may.
    expect((await globs.addRelation(BOTH, mine.id, null, { to: target.id })).ok).toBe(true);
  });

  it("the target's state drives the gate: a rollout holds, merged and rolled out releases", async () => {
    const { glob: target, step } = await rollingOut(b2);
    const holder = await make(b1, { type: 'sub', after: [target.id] });
    expect(holder.status).toBe('planning');
    expect(unwrap(await globs.get(BOTH, holder.id)).waitingFor).toMatchObject([{ id: target.id, state: 'rollout' }]);
    // Merged with an open rollout step: still holds.
    expect(await globs.releaseDependents(target.id, b2)).toEqual([]);
    expect((await current(holder.id)).status).toBe('planning');
    // The last rollout step closes: it releases the holder on the other board.
    unwrap(await globs.completeHumanStep(BOTH, target.id, step, null));
    expect((await current(holder.id)).status).toBe('implementing');
  });

  it('releaseDependents on board 2 releases a holder on board 1', async () => {
    const target = await make(b2);
    const holder = await make(b1, { type: 'sub', after: [target.id] });
    expect(holder.status).toBe('planning');
    await merge(target.id);
    expect(await globs.releaseDependents(target.id, b2)).toEqual([holder.id]);
    expect((await current(holder.id)).status).toBe('implementing');
  });

  it('refuses a cycle across two boards, including a local edge that closes a cycle through cross-board edges', async () => {
    const a = await make(b1);
    const b = await make(b2);
    unwrap(await globs.addRelation(BOTH, a.id, null, { to: b.id }));
    const back = await globs.addRelation(BOTH, b.id, null, { to: a.id });
    expect(back.ok).toBe(false);
    expect(message(back)).toContain('cycle');
    // a -> b (cross), b -> c (cross): c -> a is a local edge on board 1 that would close the loop through board 2.
    const c = await make(b1);
    unwrap(await globs.addRelation(BOTH, b.id, null, { to: c.id }));
    const local = await globs.addRelation(BOTH, c.id, null, { to: a.id });
    expect(local.ok).toBe(false);
    expect(message(local)).toContain('cycle');
    // The same through update.
    const viaUpdate = await globs.update(BOTH, c.id, (await current(c.id)).version, { after: [a.id] });
    expect(message(viaUpdate)).toContain('cycle');
  });

  describe('what a viewer sees of the other board', () => {
    it('a non-member sees "another board" with no id, title or state, from the holder side', async () => {
      const target = await make(b2, { title: 'Secret target' });
      const holder = await make(b1, { type: 'sub', after: [target.id] });
      const view = unwrap(await globs.get(ONE, holder.id));
      expect(view.holding).toHaveLength(1);
      expect(view.holding[0]).toMatchObject({ to: OTHER_BOARD, toTitle: null, state: 'open', external: { boardId: b2, boardName: null, hidden: true } });
      expect(view.waitingFor).toEqual([{ id: OTHER_BOARD, state: 'open', why: 'Waits for a glob on another board' }]);
      expect(view.relationGroups.holding[0]?.to).toBe(OTHER_BOARD);
      expect(view.relations.map((r) => r.to)).toEqual([OTHER_BOARD]);
      expect(JSON.stringify(view.holding) + JSON.stringify(view.waitingFor) + JSON.stringify(view.relationGroups) + JSON.stringify(view.relations)).not.toContain(target.id);
      expect(JSON.stringify(view.holding)).not.toContain('Secret target');
      // The board list is redacted the same way.
      const listed = unwrap(await globs.listWithArtifacts(ONE, b1, {})).find((r) => r.glob.id === holder.id);
      expect(listed?.holding[0]).toMatchObject({ to: OTHER_BOARD, toTitle: null, external: { hidden: true } });
      expect(JSON.stringify(listed?.relations)).not.toContain(target.id);
    });

    it('a non-member of the holder board sees no id in waitedOnBy and holdsBack, only a count', async () => {
      const target = await make(b2);
      const holder = await make(b1, { type: 'sub', title: 'Private holder', after: [target.id] });
      const gated = await make(b1, { title: 'Gated' });
      unwrap(await globs.addRelation(BOTH, gated.id, null, { to: target.id, gate: 'sign_off', reason: 'wait' }));
      const view = unwrap(await globs.get(TWO, target.id));
      expect(view.waitedOnBy).toEqual([]);
      expect(view.relationGroups.waitedOnByOtherBoards).toBe(1);
      expect(view.relationGroups.holdsBack).toHaveLength(2);
      expect(view.relationGroups.holdsBack.find((h) => h.gate === 'sign_off')).toMatchObject({ from: OTHER_BOARD, fromTitle: null, reason: 'wait', external: { boardId: b1, hidden: true } });
      expect(JSON.stringify(view)).not.toContain(holder.id);
      expect(JSON.stringify(view)).not.toContain('Private holder');
      // The board list carries who waits for each glob, redacted likewise.
      const listed = unwrap(await globs.listWithArtifacts(TWO, b2, {})).find((r) => r.glob.id === target.id);
      expect(listed?.holdsBack).toHaveLength(2);
      expect(listed?.holdsBack?.every((h) => h.from === OTHER_BOARD && h.fromTitle === null && h.external?.hidden === true)).toBe(true);
      expect(JSON.stringify(listed?.holdsBack)).not.toContain(gated.id);
    });

    it('a member of both boards sees the other board name and the other glob', async () => {
      const target = await make(b2, { title: 'Visible target' });
      const holder = await make(b1, { type: 'sub', after: [target.id] });
      const view = unwrap(await globs.get(BOTH, holder.id));
      expect(view.holding[0]).toMatchObject({ to: target.id, toTitle: 'Visible target', external: { boardId: b2, boardName: 'Board two', hidden: false } });
      expect(view.waitingFor[0]?.id).toBe(target.id);
      const theirs = unwrap(await globs.get(BOTH, target.id));
      expect(theirs.waitedOnBy).toEqual([holder.id]);
      expect(theirs.relationGroups.holdsBack).toMatchObject([{ from: holder.id, external: { boardId: b1, boardName: 'Board one', hidden: false } }]);
      const listed = unwrap(await globs.listWithArtifacts(BOTH, b2, {})).find((r) => r.glob.id === target.id);
      expect(listed?.holdsBack?.[0]?.external).toMatchObject({ boardName: 'Board one', hidden: false });
    });

    it('a same-board glob carries no external marker and the list has no holdsBack when nothing waits', async () => {
      const first = await make(b1);
      const second = await make(b1, { type: 'sub', after: [first.id] });
      expect(unwrap(await globs.get(BOTH, second.id)).holding[0]?.external).toBeUndefined();
      const listed = unwrap(await globs.listWithArtifacts(BOTH, b1, {}));
      expect(listed.find((r) => r.glob.id === second.id)?.holdsBack).toBeUndefined();
      expect(listed.find((r) => r.glob.id === first.id)?.holdsBack).toMatchObject([{ from: second.id }]);
    });
  });

  it('s14t13 case: sign_off waits until the other board\'s glob is merged and rolled out', async () => {
    const { glob: slopSide, step } = await rollingOut(b2);
    const lab = await make(b1, { title: 'Turn on push mode' });
    unwrap(await globs.addRelation(BOTH, lab.id, null, { to: slopSide.id, gate: 'sign_off', until: 'rolled_out', reason: 'push mode needs the slop-side change deployed' }, 'held_by', 'agent'));
    expect(unwrap(await globs.get(BOTH, lab.id)).holding).toMatchObject([{ gate: 'sign_off', until: 'merged', state: 'rollout', to: slopSide.id }]);
    unwrap(await globs.completeHumanStep(BOTH, slopSide.id, step, null));
    const after = unwrap(await globs.get(BOTH, lab.id));
    expect(after.holding).toEqual([]);
    expect(after.relationGroups.done).toMatchObject([{ to: slopSide.id, how: 'met' }]);
  });

  it('a relation to a glob that no longer exists is released, across boards', async () => {
    const target = await make(b2);
    const holder = await make(b1, { type: 'sub', after: [target.id] });
    unwrap(await globs.delete(BOTH, target.id, (await current(target.id)).version));
    expect((await current(holder.id)).status).toBe('implementing');
  });
});
