import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { createDecisionInTx } from '../src/app/decision-glob.js';
import { GlobService } from '../src/app/glob-service.js';
import type { Result } from '../src/domain/errors.js';
import { groupContext, planLine } from '../src/domain/group-view.js';
import * as machine from '../src/domain/machine.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob as fixture, relation } from './fixtures.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const NOW = '2026-10-14T12:00:00.000Z';
const g = (id: string, patch: Partial<Glob> = {}): Glob => fixture({ id, group: 'chat', updatedAt: NOW, ...patch });

describe('planLine', () => {
  it('takes the first line that says something, without headings or markers', () => {
    expect(planLine('\n## Why\n- [ ] Show the group\nmore')).toBe('Why');
    expect(planLine('---\n- [x] Do it')).toBe('Do it');
    expect(planLine(null)).toBe('');
    expect(planLine('x'.repeat(300))).toHaveLength(160);
  });
});

describe('groupContext', () => {
  it('is null without a group or without neighbours', () => {
    expect(groupContext(g('s1t1', { group: null }), [], [], new Map(), [], NOW)).toBeNull();
    expect(groupContext(g('s1t1'), [g('s1t1')], [], new Map(), [], NOW)).toBeNull();
  });

  it('lists open and recently merged neighbours, leaving out old merges and the glob itself', () => {
    const me = g('s1t1');
    const members = [
      me,
      g('s1t2', { status: 'in_progress' }),
      g('s1t3', { status: 'reviewing', updatedAt: '2026-10-10T00:00:00.000Z' }),
      g('s1t4', { status: 'signed_off', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    const ctx = groupContext(me, members, [], new Map([['s1t2', '# Plan\nBuild it']]), [], NOW);
    expect(ctx?.globs.map((x) => [x.id, x.status, x.plan])).toEqual([
      ['s1t2', 'in_progress', 'Plan'],
      ['s1t3', 'reviewing', ''],
    ]);
    expect(ctx?.progress).toEqual({ merged: 2, total: 4 });
  });

  it('lists the open decisions holding the group, including one outside it, and the group\'s own open ones', () => {
    const me = g('s1t1');
    const outside = g('s1k1', { group: null, category: 'decision', status: 'planning' });
    const inside = g('s1k2', { category: 'decision', status: 'planning' });
    const decided = g('s1k3', { group: null, category: 'decision', status: 'signed_off' });
    const rels = [
      relation('s1t1', 's1k1', { gate: 'merge', until: 'decided' }),
      relation('s1t2', 's1k1', { gate: 'merge', until: 'decided' }),
      relation('s1t1', 's1k3', { gate: 'merge', until: 'decided' }),
    ];
    const ctx = groupContext(me, [me, g('s1t2'), inside], rels, new Map(), [outside, decided], NOW);
    expect(ctx?.decisions.map((d) => [d.id, d.holdsBack])).toEqual([
      ['s1k1', ['s1t1', 's1t2']],
      ['s1k2', []],
    ]);
  });

  it('leaves out dismissed relations and does not list a decision as holding its own context', () => {
    const me = g('s1t1');
    const outside = g('s1k1', { group: null, category: 'decision', status: 'planning' });
    const self = g('s1k2', { category: 'decision', status: 'planning' });
    const rels = [relation('s1t1', 's1k1', { gate: 'merge', until: 'decided', dismissedAt: NOW })];
    expect(groupContext(me, [me], rels, new Map(), [outside], NOW)).toBeNull();
    expect(groupContext(self, [self, g('s1t2')], [], new Map(), [], NOW)?.decisions).toEqual([]);
  });

  it('caps the neighbours and says how many were left out', () => {
    const members = Array.from({ length: 15 }, (_, i) => g(`s1t${i + 1}`));
    const ctx = groupContext(members[0] as Glob, members, [], new Map(), [], NOW);
    expect(ctx?.globs).toHaveLength(12);
    expect(ctx?.more).toBe(2);
  });
});

describe('get_context group section', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let boardId: number;
  const clock = { now: () => NOW };
  const create = async (title: string, group: string | null, plan = 'A plan'): Promise<Glob> =>
    unwrap(await globs.create('dev@example.com', { boardId, title, type: 'same', category: 'task', group, environment: null, autoTrigger: false, idempotencyKey: null, plan }));

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'run-1' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    artifacts = new ArtifactService({ store, clock, notifier });
    await store.transaction((tx) => tx.upsertUser({ email: 'dev@example.com', name: 'dev', active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create('dev@example.com', { name: 'demo', repo: null, timeZone: 'UTC', environments: [] })).id;
  });

  it('is absent for a glob with no group or no neighbours', async () => {
    const alone = await create('Alone', 'solo');
    const none = await create('None', null);
    expect('group' in unwrap(await artifacts.context('dev@example.com', alone.id))).toBe(false);
    expect('group' in unwrap(await artifacts.context('dev@example.com', none.id))).toBe(false);
  });

  it('shows the neighbours with a line of plan, and the open decisions', async () => {
    const mine = await create('Mine', 'chat');
    const other = await create('Other', 'Chat', '# Other part\nDetails');
    const merged = await create('Done one', 'chat');
    unwrap(await globs.applyEvent(merged.id, (gl, c) => machine.merged(gl, { sha: 'abc123' }, c)));
    const decision = await store.transaction(async (tx) =>
      unwrap(
        await createDecisionInTx(
          tx,
          { clock },
          { boardId, actor: { email: 'dev@example.com', role: 'dev' }, title: 'Which API', payload: 'p', attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'agent', outcome: null }, creationKey: 'k', group: 'chat' },
        ),
      ),
    );
    const ctx = unwrap(await artifacts.context('dev@example.com', mine.id)).group;
    expect(ctx?.globs.map((x) => [x.id, x.plan])).toEqual([
      [other.id, 'Other part'],
      [merged.id, 'A plan'],
    ]);
    expect(ctx?.decisions.map((d) => d.id)).toEqual([decision.glob.id]);
    expect(ctx?.progress).toEqual({ merged: 1, total: 3 });
  });
});
