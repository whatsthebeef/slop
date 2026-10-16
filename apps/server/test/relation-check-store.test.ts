import { BoardService, GlobService, RelationCheckService, RelationLearningService, machine } from '@slop/core';
import type { ChangeSource, DiffSummary, Glob, Relation, Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeIndex } from '../src/code-index.js';
import { PgStore } from '../src/db/store.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const patch = (added: readonly string[], start = 1): string => `@@ -${String(start === 0 ? 0 : start)},0 +${String(Math.max(start, 1))},${String(added.length)} @@\n${added.map((l) => `+${l}`).join('\n')}`;
const diff = (files: Record<string, string>): DiffSummary => ({ changedLines: 5, files: Object.keys(files), patches: files });

/** The post-merge relation check over Postgres: verdicts stored on the relation row, signals, events and the import read. */
describe('relation check in Postgres', () => {
  let drop: () => Promise<void>;
  let store: PgStore;
  let globs: GlobService;
  let check: RelationCheckService;
  let index: CodeIndex;
  let boardId = 0;
  const diffs = new Map<string, DiffSummary>();

  const make = async (): Promise<Glob> =>
    unwrap(await globs.create(DEV, { boardId, title: 'Work', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null, plan: 'A plan for the work, long enough to count.' }));
  const row = (from: string, to: string): Relation => ({
    id: `rel_${from}_${to}`,
    boardId,
    from,
    to,
    gate: 'merge',
    until: 'merged',
    reason: `needs ${to}`,
    evidence: [],
    source: 'inferred',
    kind: 'waits',
    group: null,
    dismissedAt: null,
    dismissedPlanHash: null,
    overriddenAt: null,
    createdAt: '2026-10-05T12:00:00.000Z',
  });

  beforeAll(async () => {
    const test = await createTestDatabase('relation_check');
    drop = test.drop;
    store = new PgStore(test.database.db);
    index = new CodeIndex(test.database.db);
    const notifier = { publish: (): void => undefined };
    let tick = 0;
    const clock = { now: (): string => new Date(Date.parse('2026-10-16T12:00:00.000Z') + ++tick * 1000).toISOString() };
    const ids = { runId: (): string => crypto.randomUUID() };
    const learning = new RelationLearningService({ store, notifier, clock, ids });
    globs = new GlobService({ store, notifier, clock, ids, routines: { hasRoutine: () => Promise.resolve(true) }, relationLearning: learning });
    const changes: ChangeSource = { mergedDiff: (_board, sha) => Promise.resolve(diffs.get(sha) ?? null) };
    check = new RelationCheckService({ store, clock, changes, learning, index: { importEdges: (b, from, to) => index.importEdges(b, from, to) } });
    const boards = new BoardService({ store, notifier });
    await store.transaction((tx) => tx.upsertUser({ email: DEV, name: 'Dev', active: true }));
    boardId = unwrap(await boards.create(DEV, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
  });

  afterAll(async () => {
    await drop();
  });

  it('stores a verdict on the relation row, counts it once and logs it on the merged glob', async () => {
    const b = await make();
    const a = await make();
    await store.transaction((tx) => tx.insertRelation(row(a.id, b.id)));
    diffs.set('sha_b', diff({ 'src/b.ts': patch(['export const holdWords = (r: string) => r;']) }));
    diffs.set('sha_a', diff({ 'src/a.ts': patch(['const w = holdWords(r);']) }));
    unwrap(await globs.applyEvent(b.id, (g, c) => machine.merged(g, { sha: 'sha_b' }, c)));
    unwrap(await globs.applyEvent(a.id, (g, c) => machine.merged(g, { sha: 'sha_a' }, c)));

    expect(await check.run(a.id)).toBe('done');
    expect(await check.run(a.id)).toBe('done');
    const stored = await store.transaction((tx) => tx.getRelation(`rel_${a.id}_${b.id}`));
    expect(stored).toMatchObject({ verdict: 'needed', verdictBy: 'git', verdictReason: `uses \`holdWords\` from ${b.id} (in src/a.ts)` });
    expect(stored?.verdictAt).toEqual(expect.any(String));
    const signals = await store.transaction((tx) => tx.listRelationSignals(boardId));
    expect(signals.map((s) => [s.source, s.signal, s.key])).toEqual([['inferred', 'tp_needed', `outcome:rel_${a.id}_${b.id}`]]);
    const events = await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['RelationVerdict']));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ globId: a.id, data: { to: b.id, verdict: 'needed', by: 'git' } });
  });

  it('reads import edges between two sets of files from the code index', async () => {
    await index.replace(
      boardId,
      {
        sha: 'abc',
        files: [],
        imports: [
          { from: 'src/a.ts', to: 'src/new.ts' },
          { from: 'src/a.ts', to: 'src/other.ts' },
          { from: 'src/z.ts', to: 'src/new.ts' },
        ],
        history: [],
      },
      new Date(),
    );
    expect(await index.importEdges(boardId, ['src/a.ts'], ['src/new.ts'])).toEqual([{ from: 'src/a.ts', to: 'src/new.ts' }]);
    expect(await index.importEdges(boardId, [], ['src/new.ts'])).toEqual([]);
    expect(await index.importEdges(boardId + 1, ['src/a.ts'], ['src/new.ts'])).toEqual([]);
  });

  it('judges an imported new file as needed through the index', async () => {
    const b = await make();
    const a = await make();
    await store.transaction((tx) => tx.insertRelation(row(a.id, b.id)));
    diffs.set('sha_b2', diff({ 'src/new.ts': patch(['const hidden = 1;'], 0) }));
    diffs.set('sha_a2', diff({ 'src/a.ts': patch(['// wiring']) }));
    unwrap(await globs.applyEvent(b.id, (g, c) => machine.merged(g, { sha: 'sha_b2' }, c)));
    unwrap(await globs.applyEvent(a.id, (g, c) => machine.merged(g, { sha: 'sha_a2' }, c)));
    await check.run(a.id);
    expect(await store.transaction((tx) => tx.getRelation(`rel_${a.id}_${b.id}`))).toMatchObject({ verdict: 'needed', verdictReason: `imports \`src/new.ts\` from ${b.id} (in src/a.ts)` });
  });
});
