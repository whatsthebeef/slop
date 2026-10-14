import { beforeEach, describe, expect, it } from 'vitest';
import type { DecisionAttributes } from '../src/domain/attributes.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { GroupBackfillService } from '../src/app/group-backfill-service.js';
import { IntakeService } from '../src/app/intake-service.js';
import type { Result } from '../src/domain/errors.js';
import { decisionGroup, proposeSplitGroups } from '../src/domain/group.js';
import type { GroupableGlob } from '../src/domain/group.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const g = (id: string, title: string, linked: string[] = [], group: string | null = null): GroupableGlob => ({ id, title, group, linked });

describe('proposeSplitGroups', () => {
  it('puts the parts of one split in one group named from the original title', () => {
    const globs = [
      g('s1f1', 'Glob view actions: one main button 1/4: menu'),
      g('s1f2', 'Glob view actions: one main button 2/4: popover'),
      g('s1f3', 'Glob view actions: one main button 3/4: reset'),
      g('s1f4', 'Glob view actions: one main button 4/4: more'),
    ];
    expect(proposeSplitGroups(globs, [])).toEqual(globs.map((x) => ({ id: x.id, group: 'glob-view-actions' })));
  });

  it('keeps two splits apart, and ignores a lone numbered title and globs outside a split', () => {
    const globs = [
      g('s1f1', 'Alpha work 1/2: a'),
      g('s1f2', 'Alpha work 2/2: b'),
      g('s1f3', 'Beta work 1/2: a'),
      g('s1f4', 'Beta work 2/2: b'),
      g('s1f5', 'Gamma 1/3: a'),
      g('s1f6', 'Plain glob'),
    ];
    expect(proposeSplitGroups(globs, [])).toEqual([
      { id: 's1f1', group: 'alpha-work' },
      { id: 's1f2', group: 'alpha-work' },
      { id: 's1f3', group: 'beta-work' },
      { id: 's1f4', group: 'beta-work' },
    ]);
  });

  it('joins parts whose original title was cut short when they are linked, and not when unlinked', () => {
    const linked = [g('s1f1', 'Links into a glob open it scrolled to the right section: card chips… 1/2: x', ['s1f2']), g('s1f2', 'Links into a glob open it scrolled to the right section: card chips and icons 2/2: y')];
    expect(proposeSplitGroups(linked, []).map((p) => p.group)).toEqual(['links-into-a-glob', 'links-into-a-glob']);
    expect(proposeSplitGroups([g('s1f1', linked[0]?.title ?? ''), g('s1f2', linked[1]?.title ?? '')], [])).toEqual([]);
  });

  it('gives a split that already has a group that group, and reuses an existing group of the same name', () => {
    const held = [g('s1f1', 'Alpha 1/2: a', [], 'kept'), g('s1f2', 'Alpha 2/2: b')];
    expect(proposeSplitGroups(held, [])).toEqual([{ id: 's1f2', group: 'kept' }]);
    expect(proposeSplitGroups([g('s1f1', 'Alpha 1/2: a'), g('s1f2', 'Alpha 2/2: b')], ['Alpha']).map((p) => p.group)).toEqual(['Alpha', 'Alpha']);
  });
});

describe('group backfill', () => {
  const ADMIN = 'admin@example.com';
  const DEV = 'dev@example.com';
  let store: MemoryStore;
  let globs: GlobService;
  let backfill: GroupBackfillService;
  let boardId: number;
  let suggested: string;

  const create = async (title: string, group: string | null = null): Promise<string> =>
    unwrap(await globs.create(DEV, { boardId, title, type: 'same', category: 'task', group, environment: null, autoTrigger: false, idempotencyKey: null, plan: `Plan for ${title}` })).id;
  const groupOf = async (id: string): Promise<string | null> => (await globs.peek(id))?.group ?? null;

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await new BoardService({ store, notifier }).create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await new BoardService({ store, notifier }).setMember(ADMIN, boardId, DEV, 'dev'));
    globs = new GlobService({ store, notifier, clock: { now: () => '2026-10-13T12:00:00.000Z' }, ids: { runId: () => 'r' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    suggested = '{"group": null}';
    backfill = new GroupBackfillService({ store, globs, intake: new IntakeService({ store, llm: { complete: () => Promise.resolve(suggested) } }) });
  });

  it('a dry run proposes split groups first and the model suggestion for the rest, and writes nothing', async () => {
    const a = await create('Big thing 1/2: first');
    const b = await create('Big thing 2/2: second');
    const lone = await create('Fix the sync retry');
    suggested = '{"group": "device-sync"}';
    const result = unwrap(await backfill.run(ADMIN, boardId, false));
    expect(result.applied).toBe(false);
    expect(result.items.map((i) => [i.id, i.group, i.why])).toEqual([
      [a, 'big-thing', 'split'],
      [b, 'big-thing', 'split'],
      [lone, 'device-sync', 'suggested'],
    ]);
    expect(await groupOf(a)).toBeNull();
    expect(await groupOf(lone)).toBeNull();
  });

  it('apply writes each group, and a re-run proposes nothing for them', async () => {
    const a = await create('Big thing 1/2: first');
    const b = await create('Big thing 2/2: second');
    const grouped = await create('Already grouped', 'mine');
    const result = unwrap(await backfill.run(ADMIN, boardId, true));
    expect(result).toMatchObject({ applied: true, items: [{ id: a, result: 'applied' }, { id: b, result: 'applied' }] });
    expect(await groupOf(a)).toBe('big-thing');
    expect(await groupOf(b)).toBe('big-thing');
    expect(await groupOf(grouped)).toBe('mine');
    expect(unwrap(await backfill.run(ADMIN, boardId, false)).items).toEqual([]);
  });

  it('is for the board admins', async () => {
    await create('Big thing 1/2: first');
    const refused = await backfill.run(DEV, boardId, false);
    expect(refused.ok).toBe(false);
  });
});

describe('the group a decision glob starts in', () => {
  const attributes = (patch: Partial<DecisionAttributes>): DecisionAttributes => ({
    scope: { kind: 'project', ref: null },
    origin: { kind: 'submitted' },
    channel: 'agent',
    outcome: null,
    ...patch,
  });

  it('is the routed target of a learning, hotspots for a hotspot, else the scoped glob\'s group', () => {
    const routed = { kind: 'doc' as const, name: 'build_test_lint', section: null, newDocument: null };
    expect(decisionGroup(attributes({ target: { suggested: 'build doc', routed } }), 'g')).toBe('build_test_lint');
    expect(decisionGroup(attributes({ target: { suggested: 'build doc', routed: null } }), null)).toBeNull();
    expect(decisionGroup(attributes({ origin: { kind: 'hotspot', path: 'a.ts' } }), 'g')).toBe('hotspots');
    expect(decisionGroup(attributes({ origin: { kind: 'extracted', decisionId: 1 } }), 'g')).toBe('g');
  });
});
