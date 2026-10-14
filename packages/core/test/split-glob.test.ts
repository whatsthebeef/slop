import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService, fillPartIds, splitEscalations } from '../src/app/glob-service.js';
import type { SplitInput, SplitPart } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import { defaultAreas } from '../src/domain/risk-area.js';
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

  const part = (patch: Partial<SplitPart> = {}): SplitPart => ({ title: 'Part', plan: 'Do it', ...patch });
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
      await globs.create(ADMIN, {
        boardId,
        title: 'Big',
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
          part({ title: 'First', plan: 'First, then {part:1} and {part:2}' }),
          part({ title: 'Second', plan: 'Second, needs {part:0}', after: [0], category: 'feature', attachments: ['Data'] }),
          part({ title: 'Third', plan: 'Third', after: [0, 1] }),
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
    expect(await planOf(first.id)).toContain(`First, then ${second.id} and ${third.id}`);
    expect(await planOf(second.id)).toContain(`Second, needs ${first.id}`);
    expect(await planOf(second.id)).toContain(`Split from ${first.id} on 2026-10-09`);
    const attached = (await store.transaction((tx) => tx.listArtifacts(second.id, 'attachment'))).map((a) => a.label).sort();
    expect(attached).toEqual(['Data', 'Spec']);
    expect(await store.transaction((tx) => tx.listArtifacts(third.id, 'attachment'))).toHaveLength(1);
    expect(await store.transaction((tx) => tx.listGlobs(boardId, {}))).toHaveLength(3);
  });

  it('puts every part of a split of a group-less glob in one group named from its title', async () => {
    const bare = unwrap(
      await globs.create(ADMIN, { boardId, title: 'Billing overhaul: all of it', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'All' }),
    );
    const parts = unwrap(
      await globs.split(DEV, bare.id, bare.version, input([part({ title: 'Billing overhaul 1/2: model' }), part({ title: 'Billing overhaul 2/2: ui', after: [0] })])),
    );
    expect(parts.map((g) => g.group)).toEqual(['billing-overhaul', 'billing-overhaul']);
    expect((await current(bare.id)).group).toBe('billing-overhaul');
  });

  it('reuses an existing group whose name matches, and keeps a grouped original\'s group', async () => {
    unwrap(
      await globs.create(ADMIN, { boardId, title: 'Other', type: 'same', category: 'task', group: 'Billing Overhaul', environment: null, autoTrigger: false, idempotencyKey: null, plan: 'x' }),
    );
    const bare = unwrap(
      await globs.create(ADMIN, { boardId, title: 'Billing overhaul: all of it', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'All' }),
    );
    const parts = unwrap(await globs.split(DEV, bare.id, bare.version, input([part({ title: 'A' }), part({ title: 'B', after: [0] })])));
    expect(parts.map((g) => g.group)).toEqual(['Billing Overhaul', 'Billing Overhaul']);
    const grouped = unwrap(await globs.split(DEV, original.id, original.version, input([part({ title: 'A' }), part({ title: 'B', after: [0] })])));
    expect(grouped.map((g) => g.group)).toEqual(['grp', 'grp']);
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

  it('splits a glob whose earlier run was discarded back to Planning, and names what started one that is still going', async () => {
    const running = unwrap(await globs.start(DEV, original.id, original.version));
    const refused = await globs.split(DEV, original.id, running.version, input([part(), part()]));
    expect(!refused.ok && refused.error.message).toMatch(/has started \(.*run run-\d+ started/);
    const again = unwrap(await globs.startAgain(DEV, original.id, running.version));
    expect(again.status).toBe('planning');
    const parts = unwrap(await globs.split(DEV, original.id, again.version, input([part(), part()])));
    expect(parts).toHaveLength(2);
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

  describe('risk areas per part', () => {
    const AUTH = 'Change `apps/server/src/auth/token.ts`.';
    const INFRA = 'Change `infra/iam.tf`.';
    const DOCS = 'Tidy `docs/guide/intro.md`.';
    const eventsOf = async (type: 'Escalated' | 'Deescalated') =>
      store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', [type]));
    const makeSub = async (): Promise<Glob> =>
      unwrap(
        await globs.create(ADMIN, {
          boardId,
          title: 'Sub',
          type: 'sub',
          after: [original.id],
          category: 'task',
          group: 'grp',
          environment: null,
          autoTrigger: false,
          idempotencyKey: null,
          plan: 'Everything',
        }),
      );

    it('escalates the parts that hit a risk area with their own evidence and clears the original', async () => {
      const sub = await makeSub();
      unwrap(
        await globs.escalateToSame(DEV, sub.id, {
          reason: 'Whole feature',
          evidence: 'risk tier high, 46 files',
          criterion: 'auth_permissions',
        }),
      );
      const escalated = await current(sub.id);
      const result = unwrap(
        await globs.split(
          DEV,
          sub.id,
          escalated.version,
          input([
            part({ plan: DOCS }),
            part({ plan: AUTH, after: [0] }),
            part({ plan: DOCS, after: [0], type: 'sub' }),
          ]),
        ),
      );
      expect(result[0]?.escalation ?? null).toBeNull();
      expect(result[1]?.type).toBe('same');
      expect(result[1]?.escalation?.reason).toBe(
        "Touches the board's risk areas: Auth and security",
      );
      expect(result[1]?.escalation?.evidence).toBe(
        `From the split of ${sub.id}: files apps/server/src/auth/token.ts, areas Auth and security`,
      );
      expect(result[1]?.escalation?.criterion).toBe('auth_permissions');
      expect(result[2]?.type).toBe('sub');
      expect(result[2]?.escalation ?? null).toBeNull();
      expect((await eventsOf('Deescalated')).map((e) => e.globId)).toEqual([sub.id]);
      expect((await eventsOf('Escalated')).map((e) => e.globId)).toContain(result[1]?.id);
    });

    it('escalates a matching part of an unescalated glob, even one the proposal made a sub', async () => {
      const result = unwrap(
        await globs.split(
          DEV,
          original.id,
          original.version,
          input([part({ plan: DOCS }), part({ plan: INFRA, after: [0], type: 'sub' })]),
        ),
      );
      expect(result[0]?.escalation ?? null).toBeNull();
      expect(result[1]?.type).toBe('same');
      expect(result[1]?.escalation?.reason).toContain('Infrastructure and production');
      expect(await eventsOf('Deescalated')).toEqual([]);
      expect(await eventsOf('Escalated')).toHaveLength(1);
    });

    it('escalates part 1 itself when it matches, turning a sub into a same', async () => {
      const sub = await makeSub();
      const result = unwrap(
        await globs.split(
          DEV,
          sub.id,
          sub.version,
          input([part({ plan: AUTH }), part({ plan: DOCS, after: [0] })]),
        ),
      );
      expect(result[0]?.type).toBe('same');
      expect(result[0]?.escalation?.evidence).toContain('apps/server/src/auth/token.ts');
      expect(result[1]?.escalation ?? null).toBeNull();
    });

    it('carries the original escalation on part 1 when no part matches on its own', async () => {
      const sub = await makeSub();
      unwrap(
        await globs.escalateToSame(DEV, sub.id, {
          reason: 'Whole feature',
          evidence: 'risk tier high, 46 files',
          criterion: 'auth_permissions',
        }),
      );
      const escalated = await current(sub.id);
      const result = unwrap(
        await globs.split(
          DEV,
          sub.id,
          escalated.version,
          input([part({ plan: DOCS }), part({ plan: DOCS, after: [0] })]),
        ),
      );
      expect(result[0]?.escalation?.reason).toBe('Whole feature');
      expect(result[0]?.escalation?.evidence).toBe(
        `carried from ${sub.id}; no part matched on its own`,
      );
      expect(result[0]?.type).toBe('same');
      expect(result[1]?.escalation ?? null).toBeNull();
      expect(await eventsOf('Deescalated')).toEqual([]);
      expect((await eventsOf('Escalated')).filter((e) => e.globId === sub.id)).toHaveLength(2);
    });

    it('records nothing when no part matches and nothing was escalated', async () => {
      unwrap(
        await globs.split(
          DEV,
          original.id,
          original.version,
          input([part({ plan: DOCS }), part({ plan: DOCS, after: [0] })]),
        ),
      );
      expect(await eventsOf('Escalated')).toEqual([]);
      expect(await eventsOf('Deescalated')).toEqual([]);
    });
  });

  it('fills placeholders, leaving unknown parts as written', () => {
    expect(fillPartIds('{part:0} {part:1} {part:9}', ['a', 'b'])).toBe('a b {part:9}');
  });
});

describe('splitEscalations', () => {
  const NOW = '2026-10-13T12:00:00.000Z';
  const areas = defaultAreas(1, NOW);
  const AUTH = 'Change `apps/server/src/auth/token.ts`.';
  const DOCS = 'Tidy `docs/guide/intro.md`.';
  const original = (escalation?: Glob['escalation']): Glob =>
    ({ id: 's1f1', type: 'same', ...(escalation === undefined ? {} : { escalation }) }) as unknown as Glob;
  const whole = { reason: 'Whole feature', criterion: 'auth_permissions', evidence: 'risk tier high, 46 files', by: 'x', at: NOW } as const;

  it('replaces the original evidence on part 0 when it matches, keeping the criterion', () => {
    const [first] = splitEscalations(original(whole), [{ plan: AUTH, type: 'same' }, { plan: DOCS, type: 'same' }], areas, 'dev', NOW);
    expect(first?.escalation?.criterion).toBe('auth_permissions');
    expect(first?.escalation?.evidence).toContain('apps/server/src/auth/token.ts');
    expect(first?.escalation?.evidence).not.toContain('46 files');
    expect(first?.change?.kind).toBe('Escalated');
  });

  it('does not carry onto part 0 when a later part matches, and de-escalates part 0', () => {
    const result = splitEscalations(original(whole), [{ plan: DOCS, type: 'same' }, { plan: AUTH, type: 'same' }], areas, 'dev', NOW);
    expect(result[0]?.escalation).toBeNull();
    expect(result[0]?.change?.kind).toBe('Deescalated');
    expect(result[1]?.escalation?.evidence).toContain('apps/server/src/auth/token.ts');
  });

  it('leaves supers alone', () => {
    const result = splitEscalations(original(), [{ plan: AUTH, type: 'super' }, { plan: AUTH, type: 'same' }], areas, 'dev', NOW);
    expect(result[0]?.type).toBe('super');
    expect(result[0]?.escalation).toBeNull();
    expect(result[0]?.change).toBeNull();
    expect(result[1]?.escalation).not.toBeNull();
  });

  it('changes nothing when nothing matches and nothing was escalated', () => {
    const result = splitEscalations(original(), [{ plan: DOCS, type: 'sub' }, { plan: DOCS, type: 'sub' }], areas, 'dev', NOW);
    expect(result.map((r) => [r.type, r.escalation, r.change])).toEqual([['sub', null, null], ['sub', null, null]]);
  });
});
