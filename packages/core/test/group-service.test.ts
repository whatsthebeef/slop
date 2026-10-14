import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { createDecisionInTx } from '../src/app/decision-glob.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import { GroupService } from '../src/app/group-service.js';
import type { Result } from '../src/domain/errors.js';
import { groupSummaries } from '../src/domain/group-view.js';
import * as machine from '../src/domain/machine.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob as fixture } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';

describe('groupSummaries', () => {
  const g = (id: string, group: string | null, patch: Partial<Glob> = {}): Glob => fixture({ id, group, ...patch });

  it('counts work by status under the most used spelling, and leaves decisions out of the progress', () => {
    const summaries = groupSummaries([
      g('s1t1', 'board-chat', { status: 'reviewing', updatedAt: '2026-10-01T00:00:00.000Z' }),
      g('s1t2', 'Board Chat', { status: 'in_progress', updatedAt: '2026-10-03T00:00:00.000Z' }),
      g('s1t3', 'board-chat', { status: 'planning', updatedAt: '2026-10-02T00:00:00.000Z' }),
      g('s1k1', 'board-chat', { category: 'decision', status: 'planning', updatedAt: '2026-10-05T00:00:00.000Z' }),
      g('s1t4', null),
    ]);
    expect(summaries).toEqual([
      {
        name: 'board-chat',
        progress: { merged: 1, total: 3 },
        open: 2,
        counts: { reviewing: 1, in_progress: 1, planning: 1 },
        lastActivityAt: '2026-10-05T00:00:00.000Z',
      },
    ]);
  });

  it('lists groups with open work before finished ones', () => {
    const names = groupSummaries([g('s1t1', 'done', { status: 'signed_off', updatedAt: '2026-10-09T00:00:00.000Z' }), g('s1t2', 'busy', { status: 'planning', updatedAt: '2026-10-01T00:00:00.000Z' })]).map((s) => s.name);
    expect(names).toEqual(['busy', 'done']);
  });
});

describe('GroupService', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let groups: GroupService;
  let boardId: number;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'A glob',
    type: 'same',
    category: 'task',
    group: 'chat',
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    plan: 'A plan',
    ...patch,
  });
  const create = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrap(await globs.create(ADMIN, input(patch)));
  const merge = async (id: string): Promise<Glob> => unwrap(await globs.applyEvent(id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
  const decide = (key: string, group: string | null): Promise<string> =>
    store.transaction(async (tx) => {
      const made = unwrap(
        await createDecisionInTx(
          tx,
          { clock: { now: () => '2026-10-13T12:00:00.000Z' } },
          { boardId, actor: { email: DEV, role: 'dev' }, title: key, payload: key, attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'agent', outcome: null }, creationKey: key, group },
        ),
      );
      return made.glob.id;
    });
  const groupOf = async (id: string): Promise<string | null> => (await globs.peek(id))?.group ?? null;
  const groupEvents = (id: string): unknown[] => store.state.events.filter((e) => e.globId === id && e.type === 'FieldsChanged' && 'group' in e.data).map((e) => e.data['group']);

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
    });
    let n = 0;
    const clock = { now: () => '2026-10-13T12:00:00.000Z' };
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => `r${String((n += 1))}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    groups = new GroupService({ store, globs, boards, clock });
  });

  it('lists the board\'s groups and refuses a non-member', async () => {
    await create({ title: 'One' });
    await create({ title: 'Two', group: 'other' });
    await create({ title: 'None', group: null });
    expect(unwrap(await groups.list(DEV, boardId)).map((s) => s.name).sort()).toEqual(['chat', 'other']);
    expect((await groups.list(OUTSIDER, boardId)).ok).toBe(false);
    expect((await groups.view(OUTSIDER, boardId, 'chat')).ok).toBe(false);
  });

  it('shows a group with its progress, whose move it is and the relations between its globs, holding ones first', async () => {
    const first = await create({ title: 'First' });
    const second = await create({ title: 'Second', type: 'sub', after: [first.id] });
    const elsewhere = await create({ title: 'Elsewhere', group: 'other' });
    const third = await create({ title: 'Third', type: 'sub', after: [elsewhere.id] });
    await create({ title: 'Not mine', group: 'other' });

    const view = unwrap(await groups.view(DEV, boardId, 'Chat'));
    expect(view.name).toBe('chat');
    expect(view.progress).toEqual({ merged: 0, total: 3 });
    expect(view.globs.map((x) => x.id)).toEqual([first.id, second.id, third.id]);
    expect(view.globs.find((x) => x.id === second.id)?.holding.map((h) => h.to)).toEqual([first.id]);
    expect(view.relations.map((r) => [r.from, r.to, r.holding, r.crosses])).toEqual([
      [second.id, first.id, true, false],
      [third.id, elsewhere.id, true, true],
    ]);

    await merge(first.id);
    const after = unwrap(await groups.view(DEV, boardId, 'chat'));
    expect(after.progress).toEqual({ merged: 1, total: 3 });
    expect(after.relations.find((r) => r.to === first.id)).toMatchObject({ holding: false, state: 'merged' });
    expect(after.relations[0]?.holding).toBe(true);
  });

  it('leaves deleted globs out of the group and its progress, and says so for a group that is gone', async () => {
    const keep = await create({ title: 'Keep' });
    const gone = await create({ title: 'Gone' });
    await store.transaction((tx) => tx.deleteGlob(gone.id));
    expect(unwrap(await groups.view(DEV, boardId, 'chat')).globs.map((x) => x.id)).toEqual([keep.id]);
    expect(unwrap(await groups.view(DEV, boardId, 'chat')).progress.total).toBe(1);
    const missing = await groups.view(DEV, boardId, 'nope');
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });

  it('lists the open decisions holding a glob of the group, apart from its work', async () => {
    const work = await create({ title: 'Held' });
    const decision = await decide('s1k1', null);
    unwrap(await globs.addRelation(DEV, decision, null, { to: work.id, gate: 'merge' }, 'holds_back'));
    const view = unwrap(await groups.view(DEV, boardId, 'chat'));
    expect(view.progress.total).toBe(1);
    expect(view.decisions).toEqual([{ id: decision, title: 's1k1', holdsBack: [work.id] }]);
    expect(view.relations.find((r) => r.to === decision)).toMatchObject({ toIsDecision: true, holding: true, crosses: false, gate: 'merge' });
  });

  it('counts a signed-off glob as merged in the group progress', async () => {
    const a = await create({ title: 'Signed' });
    await create({ title: 'Open' });
    await store.transaction(async (tx) => {
      const g = await tx.getGlob(a.id);
      if (g === null) throw new Error('missing');
      await tx.updateGlob({ ...g, status: 'signed_off', version: g.version + 1 }, g.version);
    });
    expect(unwrap(await groups.view(DEV, boardId, 'chat')).progress).toEqual({ merged: 1, total: 2 });
  });

  describe('rename and merge', () => {
    it('writes the new name on every glob in the group, one FieldsChanged each, and leaves relations alone', async () => {
      const first = await create({ title: 'First' });
      const second = await create({ title: 'Second', type: 'sub', after: [first.id] });
      const done = await create({ title: 'Merged' });
      await merge(done.id);
      const decision = await decide('s1k1', 'chat');
      const other = await create({ title: 'Other', group: 'other' });
      const before = [...store.state.relations.values()].map((r) => r.id);

      const result = unwrap(await groups.rename(DEV, boardId, 'CHAT', 'board-chat'));
      expect(result).toEqual({ name: 'board-chat', moved: 4, failed: [] });
      for (const id of [first.id, second.id, done.id, decision]) expect(await groupOf(id)).toBe('board-chat');
      expect(await groupOf(other.id)).toBe('other');
      expect(groupEvents(first.id)).toEqual([{ from: 'chat', to: 'board-chat' }]);
      expect([...store.state.relations.values()].map((r) => r.id)).toEqual(before);
      expect(unwrap(await groups.view(DEV, boardId, 'board-chat')).globs).toHaveLength(3);
    });

    it('is idempotent: a second call finds nothing under the old name', async () => {
      await create();
      unwrap(await groups.rename(DEV, boardId, 'chat', 'renamed'));
      const again = await groups.rename(DEV, boardId, 'chat', 'renamed');
      expect(!again.ok && again.error.code).toBe('not_found');
    });

    it('refuses a name that another group has (that is a merge), a blank or reserved name, and a long one', async () => {
      await create();
      await create({ group: 'other' });
      for (const to of ['Other', '  ', '--', 'backfill', 'x'.repeat(61)]) {
        const result = await groups.rename(DEV, boardId, 'chat', to);
        expect(!result.ok && result.error.code).toBe('invalid_input');
      }
      expect(await groupOf((await store.transaction((tx) => tx.listGlobs(boardId, {})))[0]?.id ?? '')).toBe('chat');
    });

    it('changes only the spelling when the new name matches the old one ignoring case', async () => {
      const a = await create();
      expect(unwrap(await groups.rename(DEV, boardId, 'chat', 'Chat'))).toMatchObject({ name: 'Chat', moved: 1 });
      expect(await groupOf(a.id)).toBe('Chat');
    });

    it('merges a group into another, which keeps its spelling, and refuses a missing target or itself', async () => {
      const a = await create({ title: 'A', group: 'small' });
      const b = await create({ title: 'B', group: 'Big Group' });
      const merged = unwrap(await groups.merge(DEV, boardId, 'small', 'big-group'));
      expect(merged).toEqual({ name: 'Big Group', moved: 1, failed: [] });
      expect(await groupOf(a.id)).toBe('Big Group');
      expect(await groupOf(b.id)).toBe('Big Group');
      const missing = await groups.merge(DEV, boardId, 'Big Group', 'nowhere');
      expect(!missing.ok && missing.error.code).toBe('not_found');
      const self = await groups.merge(DEV, boardId, 'Big Group', 'big group');
      expect(!self.ok && self.error.code).toBe('invalid_input');
    });

    it('retries once on the current version when a glob changed after the list was read', async () => {
      const a = await create({ title: 'Raced' });
      let raced = false;
      const racing = Object.create(globs) as GlobService;
      racing.update = async (...args: Parameters<GlobService['update']>) => {
        if (!raced) {
          raced = true;
          unwrap(await globs.update(ADMIN, a.id, a.version, { title: 'Changed meanwhile' }));
        }
        return globs.update(...args);
      };
      const result = unwrap(await new GroupService({ store, globs: racing, boards: new BoardService({ store, notifier: new RecordingNotifier() }), clock: { now: () => '2026-10-13T12:00:00.000Z' } }).rename(DEV, boardId, 'chat', 'raced'));
      expect(result).toEqual({ name: 'raced', moved: 1, failed: [] });
      expect(await groupOf(a.id)).toBe('raced');
    });

    it('refuses a non-member', async () => {
      await create();
      expect((await groups.rename(OUTSIDER, boardId, 'chat', 'x')).ok).toBe(false);
    });
  });
});
