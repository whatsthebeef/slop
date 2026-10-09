import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService, fillPartIds } from '../src/app/glob-service.js';
import type { SplitInput, SplitPart } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';

describe('split a glob into parts', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  let original: Glob;

  const part = (patch: Partial<SplitPart> = {}): SplitPart => ({ title: 'Part', summary: 's', plan: 'Do it', ...patch });
  const input = (parts: readonly SplitPart[], key: string | null = null): SplitInput => ({ parts, idempotencyKey: key });
  const planOf = async (id: string): Promise<string> => (await store.transaction((tx) => tx.listArtifacts(id, 'plan')))[0]?.content ?? '';
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    let runs = 0;
    const clock = { now: () => '2026-10-09T12:00:00.000Z' };
    const boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    artifacts = new ArtifactService({ store, clock, notifier });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    original = unwrap(
      await globs.create(DEV, {
        boardId,
        title: 'Big',
        summary: 'Everything',
        type: 'same',
        category: 'task',
        group: 'grp',
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        plan: 'Everything in one',
      }),
    );
  });

  it('keeps part 1 on the original and creates the others with their plans, group and chain', async () => {
    unwrap(await artifacts.attach(DEV, original.id, { label: 'Spec', text: null, link: 'https://example.com/spec' }));
    unwrap(await artifacts.attach(DEV, original.id, { label: 'Notes', text: 'private notes', link: null }));
    unwrap(await artifacts.attach(DEV, original.id, { label: 'Data', text: 'the data', link: null }));
    const parts = unwrap(
      await globs.split(
        DEV,
        original.id,
        original.version,
        input([
          part({ title: 'First', summary: 'one', plan: 'First, then {part:1} and {part:2}' }),
          part({ title: 'Second', summary: 'after {part:0}', plan: 'Second, needs {part:0}', after: [0], category: 'feature', attachments: ['Data'] }),
          part({ title: 'Third', summary: 'three', plan: 'Third', after: [0, 1] }),
        ]),
      ),
    );
    const [first, second, third] = parts;
    if (first === undefined || second === undefined || third === undefined) throw new Error('expected 3 parts');
    expect(first.id).toBe(original.id);
    expect(first.title).toBe('First');
    expect(first.version).toBe(original.version + 1);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(second.category).toBe('feature');
    expect(second.group).toBe('grp');
    expect(second.after).toEqual([first.id]);
    expect(third.after).toEqual([first.id, second.id]);
    expect(second.summary).toBe(`after ${first.id}`);
    expect(await planOf(first.id)).toContain(`First, then ${second.id} and ${third.id}`);
    expect(await planOf(second.id)).toContain(`Second, needs ${first.id}`);
    expect(await planOf(second.id)).toContain(`Split from ${first.id} on 2026-10-09`);
    const attached = (await store.transaction((tx) => tx.listArtifacts(second.id, 'attachment'))).map((a) => a.label).sort();
    expect(attached).toEqual(['Data', 'Spec']);
    expect(await store.transaction((tx) => tx.listArtifacts(third.id, 'attachment'))).toHaveLength(1);
    expect(await store.transaction((tx) => tx.listGlobs(boardId, {}))).toHaveLength(3);
  });

  it('records a GlobSplit event on every part', async () => {
    const parts = unwrap(await globs.split(DEV, original.id, original.version, input([part(), part()])));
    const splits = store.state.events.filter((e) => e.type === 'GlobSplit');
    expect(splits.map((e) => e.globId).sort()).toEqual(parts.map((g) => g.id).sort());
    expect(splits.map((e) => e.data['part']).sort()).toEqual([0, 1]);
    expect(splits[0]?.data['source']).toBe(original.id);
  });

  it('refuses a glob that has started', async () => {
    const started = unwrap(await globs.pickUp(DEV, original.id, original.version, false));
    const result = await globs.split(DEV, original.id, started.version, input([part(), part()]));
    expect(result.ok).toBe(false);
    expect(await store.transaction((tx) => tx.listGlobs(boardId, {}))).toHaveLength(1);
  });

  it('refuses a glob with a run', async () => {
    const running = unwrap(await globs.start(DEV, original.id, original.version));
    const result = await globs.split(DEV, original.id, running.version, input([part(), part()]));
    expect(result.ok).toBe(false);
  });

  it('refuses a stale version and writes nothing', async () => {
    const result = await globs.split(DEV, original.id, original.version + 5, input([part(), part()]));
    expect(!result.ok && result.error.code).toBe('version_conflict');
    expect(await store.transaction((tx) => tx.listGlobs(boardId, {}))).toHaveLength(1);
    expect((await current(original.id)).title).toBe('Big');
  });

  it('needs at least 2 parts and after pointing at earlier parts', async () => {
    expect((await globs.split(DEV, original.id, original.version, input([part()]))).ok).toBe(false);
    expect((await globs.split(DEV, original.id, original.version, input([part(), part({ after: [1] })]))).ok).toBe(false);
    expect((await globs.split(DEV, original.id, original.version, input([part({ after: [0] }), part()]))).ok).toBe(false);
  });

  it('returns the same parts for a retry with the same key', async () => {
    const first = unwrap(await globs.split(DEV, original.id, original.version, input([part(), part(), part()], 'k1')));
    const again = unwrap(await globs.split(DEV, original.id, original.version, input([part(), part(), part()], 'k1')));
    expect(again.map((g) => g.id)).toEqual(first.map((g) => g.id));
    expect(await store.transaction((tx) => tx.listGlobs(boardId, {}))).toHaveLength(3);
  });

  it('holds subs until the parts they wait for have merged', async () => {
    const parts = unwrap(
      await globs.split(DEV, original.id, original.version, input([part(), part({ type: 'sub', category: 'task', after: [0] })])),
    );
    const sub = parts[1];
    expect(sub?.status).toBe('planning');
    expect(sub?.waiting).not.toBeNull();
    expect(sub?.runs).toHaveLength(0);
  });

  it('fills placeholders, leaving unknown parts as written', () => {
    expect(fillPartIds('{part:0} {part:1} {part:9}', ['a', 'b'])).toBe('a b {part:9}');
  });
});
