import { learningSeed } from '../src/testing/learning-seed.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { EscalationLearningService } from '../src/app/escalation-learning-service.js';
import type { Result } from '../src/domain/errors.js';
import {
  criteriaOf,
  criterionForPaths,
  criterionOf,
  escalationCandidates,
  stanceOf,
} from '../src/domain/escalation-learning.js';
import type { EscalationRecord } from '../src/domain/escalation-learning.js';
import type { DomainEvent, DomainEventType } from '../src/domain/events.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const T0 = '2026-10-01T00:00:00.000Z';
const NOW = '2026-10-20T00:00:00.000Z';
const at = (day: number): string => `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`;

const event = (type: DomainEventType, globId: string, when: string, data: DomainEvent['data'] = {}, actor: string | null = null): DomainEvent => ({
  type,
  globId,
  actor,
  at: when,
  data,
});

const glob = (id: string, patch: Partial<Glob> = {}): Glob =>
  ({
    id,
    boardId: 1,
    title: id,
    summary: '',
    type: 'sub',
    category: 'task',
    status: 'reviewing',
    createdAt: T0,
    ...patch,
  }) as Glob;

const escalated = (id: string, when: string, criterion = 'design_decision'): DomainEvent =>
  event('Escalated', id, when, { reason: 'Unplanned design choice', criterion });

describe('escalation criteria', () => {
  it('reads the named criterion, else the reason, else other', () => {
    expect(criterionOf('risk_area', 'x')).toBe('risk_area');
    expect(criterionOf(undefined, 'Changes the agent instructions in .claude/')).toBe('agent_instructions');
    expect(criterionOf('nonsense', 'Rewrites existing data in a migration')).toBe('data_rewrite');
    expect(criterionOf(undefined, 'something odd')).toBe('other');
    expect(criterionForPaths(['.claude/agents/x.md'])).toBe('agent_instructions');
    expect(criterionForPaths(['src/a.ts'])).toBe('other');
  });

  it('turns a score into a stance, and a reset clears the history before it', () => {
    expect(stanceOf(0)).toBe('default');
    expect(stanceOf(-1)).toBe('loosened');
    expect(stanceOf(1)).toBe('strengthened');
    const record = (id: number, when: string, outcome: EscalationRecord['outcome'], weight: number): EscalationRecord => ({
      id,
      boardId: 1,
      at: when,
      globId: outcome === 'reset' ? null : `s1t${id}`,
      criterion: 'design_decision',
      outcome,
      weight,
      cause: 'x',
    });
    const records = [record(1, at(1), 'unnecessary', -1), record(2, at(2), 'unnecessary', -1)];
    const design = (list: readonly EscalationRecord[]) => criteriaOf(list).find((c) => c.criterion === 'design_decision');
    expect(design(records)).toMatchObject({ score: -2, stance: 'loosened', unnecessary: 2 });
    expect(design([...records, record(3, at(3), 'reset', 0)])).toMatchObject({ score: 0, stance: 'default' });
    expect(design([...records, record(3, at(3), 'reset', 0), record(4, at(4), 'missed', 2)])).toMatchObject({ score: 2, stance: 'strengthened' });
  });
});

describe('escalation outcomes (pure)', () => {
  const run = (globs: Glob[], events: DomainEvent[]) => escalationCandidates({ globs, events, recorded: new Set(), now: NOW });

  it('an escalation merged with nothing asked of it is unnecessary, with its cause', () => {
    const out = run([glob('s1t1', { status: 'signed_off' })], [escalated('s1t1', at(2)), event('Merged', 's1t1', at(3))]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ outcome: 'unnecessary', criterion: 'design_decision', weight: -1 });
    expect(out[0]?.cause).toContain('Unplanned design choice');
  });

  it('waits for the sign-off or the window before calling a merged escalation unnecessary', () => {
    const events = [escalated('s1t1', at(2)), event('Merged', 's1t1', at(18))];
    expect(run([glob('s1t1', { status: 'reviewing' })], events)).toEqual([]);
  });

  it('changes asked for, or a revert, make an escalation justified', () => {
    const asked = run(
      [glob('s1t1')],
      [escalated('s1t1', at(2)), event('Merged', 's1t1', at(3)), event('LabelChanged', 's1t1', at(4), { label: 'QA', to: 'added' })],
    );
    expect(asked[0]).toMatchObject({ outcome: 'justified', weight: 1 });
    expect(asked[0]?.cause).toContain('asked for changes');
    const reverted = run([glob('s1t1')], [escalated('s1t1', at(2)), event('Merged', 's1t1', at(3)), event('MergeReverted', 's1t1', at(5))]);
    expect(reverted[0]).toMatchObject({ outcome: 'justified' });
    expect(reverted[0]?.cause).toContain('reverted');
  });

  it('a de-escalation is a strong unnecessary, even before the merge', () => {
    const out = run(
      [glob('s1t1', { status: 'pr_open' })],
      [escalated('s1t1', at(2), 'risk_area'), event('Deescalated', 's1t1', at(3), { reason: 'x' }, 'dev@example.com')],
    );
    expect(out[0]).toMatchObject({ outcome: 'unnecessary', criterion: 'risk_area', weight: -3 });
    expect(out[0]?.cause).toContain('dev@example.com');
  });

  it('a sub merged with no escalation then reverted or blamed by a bug is a missed escalation', () => {
    const reverted = run([glob('s1t2')], [event('Merged', 's1t2', at(3)), event('MergeReverted', 's1t2', at(4))]);
    expect(reverted[0]).toMatchObject({ outcome: 'missed', weight: 2, needsPaths: true });
    const bug = glob('s1b3', { category: 'bug', title: 'Broken after s1t2', createdAt: at(5) });
    const blamed = run([glob('s1t2'), bug], [event('Merged', 's1t2', at(3))]);
    expect(blamed[0]).toMatchObject({ outcome: 'missed' });
    expect(blamed[0]?.cause).toContain('s1b3');
    // a bug naming s1t20 does not blame s1t2, and one before the merge doesn't either
    expect(run([glob('s1t2'), glob('s1b4', { category: 'bug', title: 's1t20 broke', createdAt: at(5) })], [event('Merged', 's1t2', at(3))])).toEqual([]);
    expect(run([glob('s1t2'), glob('s1b5', { category: 'bug', title: 'old s1t2 issue', createdAt: at(1) })], [event('Merged', 's1t2', at(3))])).toEqual([]);
  });

  it('a person making a merged sub\'s follow-up a same is a heavy missed escalation', () => {
    const followUp = glob('s1t9', { type: 'same', title: 'Follow-up to s1t2' });
    const out = run(
      [glob('s1t2'), followUp],
      [event('Merged', 's1t2', at(3)), event('FieldsChanged', 's1t9', at(4), { type: { from: 'sub', to: 'same' } }, 'po@example.com')],
    );
    expect(out[0]).toMatchObject({ outcome: 'missed', weight: 3 });
    // the same change made by the system is not a person's correction
    expect(run([glob('s1t2'), followUp], [event('Merged', 's1t2', at(3)), event('FieldsChanged', 's1t9', at(4), { type: { from: 'sub', to: 'same' } })])).toEqual([]);
  });

  it('skips outcomes already recorded', () => {
    const events = [escalated('s1t1', at(2)), event('Merged', 's1t1', at(3))];
    expect(
      escalationCandidates({ globs: [glob('s1t1', { status: 'signed_off' })], events, recorded: new Set(['s1t1:unnecessary']), now: NOW }),
    ).toEqual([]);
  });
});

describe('escalation learning service', () => {
  let store: MemoryStore;
  let service: EscalationLearningService;
  let notifier: RecordingNotifier;
  let boardId: number;

  const seed = async (globs: Glob[], events: DomainEvent[]): Promise<void> => {
    await store.transaction(async (tx) => {
      for (const g of globs) await tx.insertGlob({ ...g, boardId }, null);
      await tx.appendEvents(events);
    });
  };
  const records = () => store.transaction((tx) => tx.listEscalationRecords(boardId));
  const items = () => store.transaction((tx) => learningSeed(tx).listSeeded(boardId, 'open'));

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    const boards = new BoardService({ store, notifier });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    service = new EscalationLearningService({ store, clock: { now: () => NOW }, notifier });
  });

  it('an escalation approved unchanged loosens its criterion, with its cause in the history and a learning proposed', async () => {
    await seed([glob('s1t1', { status: 'signed_off' })], [escalated('s1t1', at(2)), event('Merged', 's1t1', at(3))]);
    expect(await service.learn(boardId, NOW)).toBe(1);
    const view = unwrap(await service.view(ADMIN, boardId));
    expect(view.criteria.find((c) => c.criterion === 'design_decision')).toMatchObject({ stance: 'loosened', unnecessary: 1 });
    expect(view.history[0]).toMatchObject({ outcome: 'unnecessary', globId: 's1t1' });
    expect(view.history[0]?.cause).toContain('merged with nothing asked of it');
    expect(await records()).toHaveLength(1);
    const proposed = await items();
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ type: 'agent-behaviour', sourceGlobIds: ['s1t1'], status: 'open' });
    expect(proposed[0]?.statement).toContain('unnecessary');
    // The item is its decision glob (same ID), like every new KB item, published after the commit.
    const itemId = proposed[0]?.id ?? '';
    expect(await store.transaction((tx) => tx.getGlob(itemId))).toMatchObject({ category: 'decision', status: 'planning', attributes: { origin: { kind: 'mined' }, channel: 'mined' } });
    expect(notifier.hints).toContainEqual({ kind: 'glob.changed', boardId, globId: itemId, version: 1 });
    // idempotent: a second pass records and proposes nothing
    expect(await service.learn(boardId, NOW)).toBe(0);
    expect(await items()).toHaveLength(1);
  });

  it('a missed escalation (revert or follow-up bug) strengthens a criterion', async () => {
    await seed(
      [glob('s1t2'), glob('s1b3', { category: 'bug', title: 'Broke s1t2', createdAt: at(5) })],
      [event('Merged', 's1t2', at(3))],
    );
    expect(await service.learn(boardId, NOW)).toBe(1);
    const view = unwrap(await service.view(ADMIN, boardId));
    expect(view.criteria.find((c) => c.criterion === 'other')).toMatchObject({ stance: 'strengthened', missed: 1 });
    expect(view.history[0]?.cause).toContain('s1b3');
    expect((await items())[0]?.statement).toContain('needed a human');
  });

  it('a justified escalation cancels an unnecessary one, and a reset restores the defaults but keeps the history', async () => {
    await seed(
      [glob('s1t1', { status: 'signed_off' }), glob('s1t2')],
      [
        escalated('s1t1', at(2)),
        event('Merged', 's1t1', at(3)),
        escalated('s1t2', at(4)),
        event('Merged', 's1t2', at(5)),
        event('MergeReverted', 's1t2', at(6)),
      ],
    );
    await service.learn(boardId, NOW);
    const view = unwrap(await service.view(ADMIN, boardId));
    expect(view.criteria.find((c) => c.criterion === 'design_decision')).toMatchObject({ score: 0, stance: 'default' });
    expect(view.history).toHaveLength(2);
    const after = unwrap(await service.reset(ADMIN, boardId));
    expect(after.history).toHaveLength(3);
    expect(after.criteria.every((c) => c.stance === 'default' && c.score === 0)).toBe(true);
  });

  it('only admins reset', async () => {
    await store.transaction((tx) => tx.upsertUser({ email: 'dev@example.com', name: 'dev', active: true }));
    const result = await service.reset('dev@example.com', boardId);
    expect(result.ok).toBe(false);
  });
});
