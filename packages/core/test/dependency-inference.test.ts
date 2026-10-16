import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { DependencyInferenceService, parseEdges, refineEdges } from '../src/app/dependency-inference-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import type { Result } from '../src/domain/errors.js';
import type { DecisionAttributes } from '../src/domain/attributes.js';
import type { Glob } from '../src/domain/types.js';
import { glob as fixture } from './fixtures.js';
import { hash } from '../src/app/text-hash.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const PLAN = 'Add the humanSteps() helper and show it in the glob view, with tests for each kind of step it lists.';

describe('dependency inference', () => {
  let store: MemoryStore;
  let boards: BoardService;
  let globs: GlobService;
  let inference: DependencyInferenceService;
  let boardId: number;
  let answer: () => string;
  let prompts: LlmRequest[];
  let asked: number;

  const llm: Llm = {
    complete: (request) => {
      asked++;
      prompts.push(request);
      return Promise.resolve(answer());
    },
  };
  const edges = (
    ...items: { id: string; kind: string; reason?: string; files?: string[]; symbol?: string; addedBy?: string; confidence?: number; question?: string }[]
  ): (() => string) => () =>
    JSON.stringify({
      edges: items.map((i) => ({
        reason: 'uses humanSteps() from it',
        files: ['a.ts'],
        ...(i.kind === 'needs' ? { symbol: 'humanSteps', addedBy: i.id, confidence: 0.9 } : {}),
        ...(i.kind !== 'overlaps' ? { question: 'Which store holds the widgets: Postgres or DynamoDB?' } : {}),
        ...i,
      })),
    });

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Add a thing',
    plan: PLAN,
    type: 'sub',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  /** A glob's inferred and other start relations: the glob it waits for, whether that is a need or an open decision, its source and reason. */
  const edgesOf = (g: Glob) =>
    [...store.state.relations.values()]
      .filter((r) => r.from === g.id && r.gate === 'start')
      .map((r) => ({
        id: r.to,
        kind: r.until === 'decided' ? ('decision' as const) : ('needs' as const),
        source: r.source,
        paths: r.evidence,
        ...(r.reason === null ? {} : { evidence: r.reason }),
        ...(r.dismissedAt !== null ? { dismissed: true as const } : {}),
        ...(r.overriddenAt !== null ? { overridden: true as const } : {}),
      }));
  const create = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrap(await globs.create(ADMIN, input(patch)));
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  /** An open decision glob on the board, its statement as the plan. */
  const decision = async (id: string, statement: string, patch: Partial<Glob> = {}, attributes: Partial<DecisionAttributes> = {}): Promise<Glob> => {
    const g = fixture({
      id,
      boardId,
      title: statement.slice(0, 40),
      category: 'decision',
      status: 'planning',
      pr: null,
      provisioning: 'none',
      attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'manual' }, channel: 'agent', outcome: null, ...attributes },
      ...patch,
    });
    store.state.globs.set(id, { glob: g, creationKey: null });
    await store.transaction((tx) =>
      tx.insertArtifact({ globId: id, kind: 'plan', label: '', content: statement, link: null, commitSha: null, provenance: { by: 'human', actor: DEV, runId: null, agentSetVersion: null }, createdAt: '2026-10-05T12:00:00.000Z' }),
    );
    return g;
  };
  const savePlan = (id: string, content: string) =>
    store.transaction((tx) =>
      tx.insertArtifact({
        globId: id,
        kind: 'plan',
        label: '',
        content,
        link: null,
        commitSha: null,
        provenance: { by: 'human', actor: DEV, runId: null, agentSetVersion: null },
        createdAt: '2026-10-05T12:01:00.000Z',
      }),
    );

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    prompts = [];
    asked = 0;
    answer = () => '{"edges": []}';
    let runs = 0;
    inference = new DependencyInferenceService({ store, llm, apply: (id, found, hash) => globs.applyInferred(id, found, hash), release: (id) => globs.release(id) });
    boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock: { now: () => '2026-10-05T12:00:00.000Z' },
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
      inference: { infer: (i) => inference.infer(i) },
    });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
  });

  it('asks nothing when no other glob is open', async () => {
    const first = await create();
    expect(edgesOf(first)).toEqual([]);
    expect(asked).toBe(0);
  });

  it('infers a need at create with its reason, and it holds a sub; the model is not asked for overlaps', async () => {
    const provider = await create({ type: 'same' });
    const sibling = await create({ type: 'same' });
    answer = edges({ id: provider.id, kind: 'needs', reason: `uses humanSteps() from ${provider.id}` }, { id: sibling.id, kind: 'overlaps', reason: 'both edit glob-dialog.tsx' });
    const made = await create();
    // The overlap is no relation and is not recorded anywhere.
    expect(edgesOf(made)).toEqual([expect.objectContaining({ id: provider.id, kind: 'needs', source: 'inferred', evidence: `uses humanSteps() from ${provider.id}` })]);
    expect(made.impliedAfter ?? []).toEqual([]);
    expect(made.status).toBe('planning');
    const view = unwrap(await globs.get(DEV, made.id));
    expect(view.waitingFor.map((w) => w.id)).toEqual([provider.id]);
    expect(view.holding).toMatchObject([{ to: provider.id, gate: 'start', until: 'merged', reason: `uses humanSteps() from ${provider.id}`, source: 'inferred' }]);
    expect(prompts.at(-1)?.spend).toMatchObject({ boardId, source: 'dependency_inference' });
    expect(prompts.at(-1)?.system).not.toContain('"overlaps"');
  });

  it('infers a decision relation to an open decision found by its statement, with the reason, and it holds a sub', async () => {
    const open = await decision('s1k1', 'Which store holds the widgets: Postgres or DynamoDB?');
    await decision('s1k2', 'Use tabs in the web app', {}, { scope: { kind: 'glob', ref: 's1t99' } });
    await decision('s1k3', 'Already settled', { status: 'reviewing' }, { outcome: { kind: 'accept', by: ADMIN, at: '2026-10-05T11:00:00.000Z' } });
    answer = edges({ id: open.id, kind: 'decision', reason: 'the plan stores widgets and the store is not chosen yet' });
    const made = await create();
    expect(edgesOf(made)).toEqual([expect.objectContaining({ id: open.id, kind: 'decision', source: 'inferred', evidence: 'the plan stores widgets and the store is not chosen yet' })]);
    const row = [...store.state.relations.values()].find((r) => r.from === made.id);
    expect(row).toMatchObject({ gate: 'start', until: 'decided', reason: 'the plan stores widgets and the store is not chosen yet' });
    expect(made.status).toBe('planning');
    const view = unwrap(await globs.get(DEV, made.id));
    expect(view.holding).toMatchObject([{ to: open.id, toIsDecision: true, until: 'decided' }]);
    // Only the open decision that could govern this glob was shown to the model: not the one scoped to another glob, not the settled one.
    const shown = prompts.at(-1)?.prompt ?? '';
    expect(shown).toContain('decision s1k1');
    expect(shown).toContain('Which store holds the widgets');
    expect(shown).not.toContain('s1k2');
    expect(shown).not.toContain('s1k3');
  });

  it('a decision relation is met by accept or reject, not by needs work', async () => {
    const open = await decision('s1k1', 'Which store holds the widgets: Postgres or DynamoDB?');
    answer = edges({ id: open.id, kind: 'decision', reason: 'the store is open' });
    const made = await create();
    const decide = (kind: 'accept' | 'reject' | 'needs_work', status: Glob['status']) => {
      const g = { ...open, status, attributes: { ...(open.attributes as DecisionAttributes), outcome: { kind, by: ADMIN, at: '2026-10-05T12:00:00.000Z' } } };
      store.state.globs.set(open.id, { glob: g, creationKey: null });
    };
    decide('needs_work', 'in_progress');
    expect(unwrap(await globs.get(DEV, made.id)).waitingFor.map((w) => w.id)).toEqual([open.id]);
    decide('accept', 'reviewing');
    expect(unwrap(await globs.get(DEV, made.id)).waitingFor).toEqual([]);
    decide('reject', 'signed_off');
    expect(unwrap(await globs.get(DEV, made.id)).waitingFor).toEqual([]);
  });

  it('ignores globs the model made up, unknown kinds and answers without a reason; a kind that does not match what it points at is corrected', async () => {
    const other = await create({ type: 'same' });
    const open = await decision('s1k1', 'Which store holds the widgets: Postgres or DynamoDB?');
    answer = edges({ id: 's99t1', kind: 'needs' }, { id: other.id, kind: 'blocks' }, { id: other.id, kind: 'overlaps' }, { id: other.id, kind: 'needs', reason: '' });
    expect(edgesOf(await create())).toEqual([]);
    expect(parseEdges('not json', new Set([other.id]))).toBeNull();
    expect(parseEdges('{"edges": [', new Set([other.id]))).toBeNull();
    // The model wrote "needs" for a decision: it is a decision relation (until decided), never a need on a decision.
    expect(parseEdges(edges({ id: open.id, kind: 'needs', reason: 'x' })(), new Set([open.id]), new Set([open.id]))).toEqual([{ id: open.id, kind: 'decision', reason: 'x', files: ['a.ts'] }]);
  });

  it('an explicit after wins over an inferred edge to the same glob, and still works without any model answer', async () => {
    const provider = await create({ type: 'same' });
    answer = edges({ id: provider.id, kind: 'needs' });
    const made = await create({ after: [provider.id] });
    expect(edgesOf(made)).toEqual([expect.objectContaining({ id: provider.id, kind: 'needs', source: 'person' })]);
    answer = () => {
      throw new Error('model down');
    };
    const again = await create({ after: [provider.id] });
    expect(edgesOf(again)).toEqual([expect.objectContaining({ id: provider.id, kind: 'needs', source: 'person' })]);
  });

  it('keeps a glob super free of edges', async () => {
    const other = await create({ type: 'same' });
    answer = edges({ id: other.id, kind: 'needs' });
    const made = await create({ type: 'super', category: 'feature', start: false });
    expect(edgesOf(made)).toEqual([]);
  });

  it('refines the edges when the plan or investigation changes: adds, confirms and drops', async () => {
    const a = await create({ type: 'same' });
    const b = await create({ type: 'same' });
    const c = await create({ type: 'same' });
    answer = edges({ id: a.id, kind: 'needs', reason: 'uses its helper' });
    const made = await create({ type: 'same' });
    expect(edgesOf(made).map((e) => e.id)).toEqual([a.id]);
    answer = edges({ id: a.id, kind: 'needs', reason: 'uses its helper, reworded' }, { id: b.id, kind: 'needs', reason: 'calls its endpoint' });
    await inference.refresh(made.id);
    const refined = await current(made.id);
    expect(edgesOf(refined).map((e) => [e.id, e.kind])).toEqual([[a.id, 'needs'], [b.id, 'needs']]);
    // The reason is the model's wording and changes between answers: the relation to the same glob stays as it was.
    expect(edgesOf(refined)[0]).toMatchObject({ evidence: 'uses its helper' });
    expect(store.state.events.find((e) => e.globId === made.id && e.type === 'RelationAdded' && e.data['to'] === b.id && e.data['source'] === 'inferred')).toBeDefined();
    answer = edges({ id: c.id, kind: 'needs', reason: 'uses its type' });
    await inference.refresh(made.id);
    expect(edgesOf(await current(made.id)).map((e) => e.id)).toEqual([c.id]);
    // The same answer again changes nothing.
    const version = (await current(made.id)).version;
    await inference.refresh(made.id);
    expect((await current(made.id)).version).toBe(version);
  });

  it('the investigation refines the edges with the code it read: confirms, adds, and drops a need it found unused; a decision stays', async () => {
    const a = await create({ type: 'same' });
    const c = await create({ type: 'same' });
    const open = await decision('s1k1', 'Which store holds the widgets: Postgres or DynamoDB?');
    answer = edges({ id: a.id, kind: 'needs', reason: 'guessed from the plan' }, { id: open.id, kind: 'decision', reason: 'the store is open' });
    const made = await create({ type: 'same' });
    expect(edgesOf(made).map((e) => [e.id, e.kind])).toEqual([[a.id, 'needs'], [open.id, 'decision']]);
    const investigation = (field: Record<string, unknown>) =>
      `# Investigation\n\n\`\`\`investigation\n${JSON.stringify({
        files: [{ path: 'x.ts', change: 'modify' }],
        modules: ['core'],
        expectedLines: { min: 1, max: 5 },
        parts: [],
        riskTier: 'low',
        riskAreas: [],
        needsHuman: { needed: false, reason: null },
        confidence: 'high',
        ...field,
        planHash: 'p',
        baseCommit: 'c',
      })}\n\`\`\``;
    const push = (content: string) =>
      store.transaction((tx) =>
        tx.insertArtifact({ globId: made.id, kind: 'investigation', label: '', content, link: null, commitSha: null, provenance: { by: 'human', actor: DEV, runId: null, agentSetVersion: null }, createdAt: '2026-10-05T12:02:00.000Z' }),
      );
    // The model still says a; the investigator read the code, uses c instead, and found nothing used from a.
    answer = edges({ id: a.id, kind: 'needs', reason: 'guessed again' }, { id: open.id, kind: 'decision', reason: 'the store is open' });
    await push(investigation({ relations: [{ to: c.id, reason: 'calls parseEdges() in dependency-inference-service.ts', files: ['dependency-inference-service.ts'] }, { to: 's99t9', reason: 'not on the board' }, { to: a.id, gate: 'merge', reason: 'a merge relation is not inferred' }] }));
    await inference.refresh(made.id);
    const refined = edgesOf(await current(made.id));
    expect(refined.map((e) => [e.id, e.kind]).sort()).toEqual([[open.id, 'decision'], [c.id, 'needs']]);
    expect(refined.find((e) => e.id === c.id)).toMatchObject({ source: 'inferred', evidence: 'calls parseEdges() in dependency-inference-service.ts', paths: ['dependency-inference-service.ts'] });
    // With no model answer the investigator's findings stand on their own; the older `dependencies` shape reads the same.
    const lone = new DependencyInferenceService({ store, apply: (id, found, planHash) => globs.applyInferred(id, found, planHash) });
    await push(investigation({ dependencies: [{ id: a.id, kind: 'needs', reason: 'uses its helper after all' }, { id: c.id, kind: 'overlaps', reason: 'same file' }] }));
    await lone.refresh(made.id);
    expect(edgesOf(await current(made.id)).map((e) => [e.id, e.kind]).sort()).toEqual([[open.id, 'decision'], [a.id, 'needs']]);
    // Looked and found none, or named only a glob that is not a candidate, with no model: the recorded edges are left alone.
    await push(investigation({ relations: [] }));
    await lone.refresh(made.id);
    expect(edgesOf(await current(made.id)).map((e) => [e.id, e.kind]).sort()).toEqual([[open.id, 'decision'], [a.id, 'needs']]);
    await push(investigation({ relations: [{ to: 's99t9', reason: 'made up' }] }));
    await lone.refresh(made.id);
    expect(edgesOf(await current(made.id)).map((e) => [e.id, e.kind]).sort()).toEqual([[open.id, 'decision'], [a.id, 'needs']]);
    // The same when the model's answer is garbled.
    answer = () => 'not json';
    await push(investigation({ relations: [] }));
    await inference.refresh(made.id);
    expect(edgesOf(await current(made.id)).map((e) => [e.id, e.kind]).sort()).toEqual([[open.id, 'decision'], [a.id, 'needs']]);
  });

  it('a dismissed edge is not inferred again until the plan changes', async () => {
    const provider = await create({ type: 'same' });
    answer = edges({ id: provider.id, kind: 'needs' });
    const made = await create({ type: 'same' });
    const row = [...store.state.relations.values()].find((r) => r.from === made.id);
    const dismissed = unwrap(await globs.dismissRelation(DEV, made.id, made.version, row?.id ?? ''));
    expect(edgesOf(dismissed)[0]).toMatchObject({ id: provider.id, dismissed: true });
    expect(edgesOf(dismissed)[0]?.overridden).toBeUndefined();
    await inference.refresh(made.id);
    const same = await current(made.id);
    expect(edgesOf(same)).toHaveLength(1);
    expect(edgesOf(same)[0]).toMatchObject({ dismissed: true });
    // The investigation pushed on the same plan does not bring it back either.
    await inference.refresh(made.id);
    expect(edgesOf(await current(made.id))).toHaveLength(1);
    expect(edgesOf(await current(made.id))[0]).toMatchObject({ dismissed: true });
    await savePlan(made.id, `${PLAN} It now also reads the helper from ${provider.id}'s change.`);
    await inference.refresh(made.id);
    // The plan changed: the dismissal was for the old plan, so the edge is inferred afresh.
    expect(edgesOf(await current(made.id))).toEqual([expect.objectContaining({ id: provider.id, kind: 'needs', source: 'inferred' })]);
    expect(edgesOf(await current(made.id))[0]?.dismissed).toBeUndefined();
  });

  it('Start now is not a dismissal: the overridden relation stays and is not inferred again for the same glob', async () => {
    const provider = await create({ type: 'same' });
    answer = edges({ id: provider.id, kind: 'needs' });
    const made = await create();
    unwrap(await globs.startAnyway(DEV, made.id, made.version));
    expect(edgesOf(await current(made.id))[0]).toMatchObject({ id: provider.id, overridden: true });
    expect(edgesOf(await current(made.id))[0]?.dismissed).toBeUndefined();
  });

  it('never creates a cycle: a need on a glob that already waits for this one is dropped with a note', async () => {
    const first = await create({ type: 'same' });
    const second = await create({ type: 'same', after: [first.id] });
    answer = edges({ id: second.id, kind: 'needs', reason: 'uses its endpoint' });
    await inference.refresh(first.id);
    const after = await current(first.id);
    expect(edgesOf(after)).toEqual([]);
    const note = store.state.events.find((e) => e.globId === first.id && e.type === 'EdgesInferred');
    expect(JSON.stringify(note?.data.notes)).toContain(`Dropped the need on ${second.id}`);
  });

  it('never creates a cycle that runs through another board (R1-3)', async () => {
    const first = await create({ type: 'same' });
    const second = await create({ type: 'same' });
    const other = unwrap(await boards.create(ADMIN, { name: 'Other', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    const abroad = unwrap(await globs.create(ADMIN, input({ boardId: other, type: 'same' })));
    // second -> abroad (stored on board 1), abroad -> first (stored on board 2): first -> second would close the loop.
    unwrap(await globs.addRelation(ADMIN, second.id, null, { to: abroad.id }));
    unwrap(await globs.addRelation(ADMIN, abroad.id, null, { to: first.id }));
    answer = edges({ id: second.id, kind: 'needs', reason: 'uses its endpoint' });
    await inference.refresh(first.id);
    expect(edgesOf(await current(first.id))).toEqual([]);
    const note = store.state.events.find((e) => e.globId === first.id && e.type === 'EdgesInferred');
    expect(JSON.stringify(note?.data.notes)).toContain(`Dropped the need on ${second.id}`);
  });

  it('a glob that has started holds nothing, so nothing is written for it', async () => {
    const provider = await create({ type: 'same' });
    const running = await create({ type: 'sub', after: [] });
    expect(running.status).toBe('implementing');
    answer = edges({ id: provider.id, kind: 'needs', reason: 'uses its helper' });
    await inference.refresh(running.id);
    expect(edgesOf(await current(running.id))).toEqual([]);
    expect((await current(running.id)).impliedAfter ?? []).toEqual([]);
  });

  it('an unparseable or cut-off answer leaves the edges as they were; only a well-formed empty list clears them', async () => {
    const other = await create({ type: 'same' });
    answer = edges({ id: other.id, kind: 'needs', reason: 'uses it' });
    const made = await create({ type: 'same' });
    for (const bad of ['I cannot help with that.', '{"edges": [{"id": "', '{"foo": 1}']) {
      answer = () => bad;
      await inference.refresh(made.id);
      expect(edgesOf(await current(made.id)).map((e) => e.id)).toEqual([other.id]);
    }
    answer = () => '{"edges": []}';
    await inference.refresh(made.id);
    expect(edgesOf(await current(made.id))).toEqual([]);
  });

  it('does not write when the plan changed while the model answered, so a dismissal is not lost', async () => {
    const provider = await create({ type: 'same' });
    answer = edges({ id: provider.id, kind: 'needs' });
    const made = await create({ type: 'same' });
    const oldHash = hash(PLAN);
    await savePlan(made.id, `${PLAN} Changed meanwhile.`);
    await globs.applyInferred(made.id, [], oldHash);
    expect(edgesOf(await current(made.id))[0]).toMatchObject({ id: provider.id, kind: 'needs' });
  });

  it('a model that fails leaves the edges as they were', async () => {
    const other = await create({ type: 'same' });
    answer = edges({ id: other.id, kind: 'needs', reason: 'uses it' });
    const made = await create({ type: 'same' });
    answer = () => {
      throw new Error('model down');
    };
    await inference.refresh(made.id);
    expect(edgesOf(await current(made.id)).map((e) => e.id)).toEqual([other.id]);
  });

  it('keeps a recorded relation to a decision outside the newest 20 shown, so the held glob stays held', async () => {
    const old = await decision('s1k1', 'Which store holds the widgets: Postgres or DynamoDB?', { createdAt: '2026-01-01T00:00:00.000Z' });
    answer = edges({ id: old.id, kind: 'decision', reason: 'the store is open' });
    const made = await create();
    expect(edgesOf(made).map((e) => e.id)).toEqual([old.id]);
    // 21 newer open decisions push it past the cap; the model answers only about what it is shown.
    for (let i = 0; i < 21; i++) await decision(`s1k${i + 2}`, `Unrelated question ${i}`, { createdAt: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` });
    answer = () => ((prompts.at(-1)?.prompt ?? '').includes(`decision ${old.id} `) ? edges({ id: old.id, kind: 'decision', reason: 'the store is open' })() : '{"edges": []}');
    await savePlan(made.id, `${PLAN} Saved again.`);
    await inference.refresh(made.id);
    expect(prompts.at(-1)?.prompt).toContain(`decision ${old.id} `);
    expect(edgesOf(await current(made.id)).map((e) => e.id)).toEqual([old.id]);
    expect((await current(made.id)).status).toBe('planning');
    expect(unwrap(await globs.get(DEV, made.id)).waitingFor.map((w) => w.id)).toEqual([old.id]);
  });

  describe('a need requires evidence that this glob uses what the other adds', () => {
    const MACHINE = 'Add LabelCommand to machine.ts and types.ts so labels can be changed, and show them on the board card.';
    const LOG = 'Show a flat activity log in the glob view. It reads the same machine.ts and types.ts events as before.';

    it('rejects a need whose only link is shared files (no symbol)', async () => {
      const relations = await create({ type: 'same', plan: MACHINE });
      answer = edges({
        id: relations.id,
        kind: 'needs',
        reason: 'adds LabelCommand... machine.ts changes',
        files: ['machine.ts', 'types.ts'],
        symbol: undefined,
        addedBy: undefined,
        confidence: undefined,
      });
      expect(edgesOf(await create({ plan: LOG }))).toEqual([]);
      answer = edges({ id: relations.id, kind: 'needs', symbol: 'machine.ts', files: ['machine.ts'] });
      expect(edgesOf(await create({ plan: LOG }))).toEqual([]);
    });

    it('rejects a reversed direction, a symbol the other glob does not add and a low confidence', async () => {
      const other = await create({ type: 'same', plan: MACHINE });
      const mine = (): Promise<Glob> => create({ plan: `${LOG} It calls LabelCommand when a label changes.` });
      answer = edges({ id: other.id, kind: 'needs', symbol: 'LabelCommand', addedBy: 's15f999' });
      expect(edgesOf(await mine())).toEqual([]);
      answer = edges({ id: other.id, kind: 'needs', symbol: 'ActivityFeed' });
      expect(edgesOf(await mine())).toEqual([]);
      answer = edges({ id: other.id, kind: 'needs', symbol: 'LabelCommand', confidence: 0.5 });
      expect(edgesOf(await mine())).toEqual([]);
    });

    it('accepts a real symbol dependency: the other glob adds it and this one uses it', async () => {
      const other = await create({ type: 'same', plan: MACHINE });
      answer = edges({ id: other.id, kind: 'needs', symbol: 'LabelCommand', reason: 'uses LabelCommand from it', files: ['machine.ts'] });
      const made = await create({ plan: `${LOG} It calls LabelCommand when a label changes.` });
      expect(edgesOf(made)[0]).toMatchObject({ id: other.id, kind: 'needs', source: 'inferred', evidence: 'uses LabelCommand from it' });
    });

    it('tells the model the rules and the bad examples', async () => {
      await create({ type: 'same', plan: MACHINE });
      await create({ plan: LOG });
      const system = prompts.at(-1)?.system ?? '';
      expect(system).toContain('NEVER a need');
      expect(system).toContain('Activity log displays relations');
    });
  });

  describe('only real decisions hold a glob', () => {
    it('never offers a KB learning or a hotspot decision as a candidate', async () => {
      const real = await decision('s1k1', 'Which store holds the widgets: Postgres or DynamoDB?', {}, { origin: { kind: 'manual' } });
      await decision('s1k2', 'Escalate less for design decisions', {}, { origin: { kind: 'submitted' } });
      await decision('s1k3', 'New document: build_test_lint', {}, { origin: { kind: 'mined' } });
      await decision('s1k4', 'Refactor the hotspot file', {}, { origin: { kind: 'hotspot', path: 'a.ts' } });
      answer = edges({ id: real.id, kind: 'decision', reason: 'the store is open' });
      await create();
      const shown = prompts.at(-1)?.prompt ?? '';
      expect(shown).toContain('decision s1k1');
      for (const id of ['s1k2', 's1k3', 's1k4']) expect(shown).not.toContain(`decision ${id} `);
    });

    it('an edge to a learning the model names anyway is dropped', async () => {
      const learning = await decision('s1k2', 'Escalate less for design decisions: may affect the escalation policy', {}, { origin: { kind: 'submitted' } });
      answer = edges({ id: learning.id, kind: 'decision', reason: 'may affect the escalation policy' });
      const made = await create({ plan: 'Split an oversized sub into a same when the size check flags it, with a test for the escalation.' });
      expect(edgesOf(made)).toEqual([]);
    });

    it('a decision edge needs a quoted question that is in the decision', () => {
      const open = new Set(['s1k1']);
      const evidence = { own: 'x', others: new Map([['s1k1', 'Which store holds the widgets: Postgres or DynamoDB?']]) };
      const parse = (question?: string) =>
        parseEdges(JSON.stringify({ edges: [{ id: 's1k1', kind: 'decision', reason: 'open', ...(question === undefined ? {} : { question }) }] }), open, open, evidence);
      expect(parse()).toEqual([]);
      expect(parse('may affect the plan')).toEqual([]);
      expect(parse('Which store holds the widgets: Postgres or DynamoDB?')).toHaveLength(1);
      expect(parse('which  store holds the widgets')).toHaveLength(1);
    });

    it('the prompt names the "may affect" holds as wrong and asks for the question', async () => {
      await decision('s1k1', 'Which store holds the widgets: Postgres or DynamoDB?');
      await create();
      const system = prompts.at(-1)?.system ?? '';
      expect(system).toContain('may affect');
      expect(system).toContain('"question"');
    });

    it('the cleanup dismisses inferred relations to learnings only, not a person-made one or one to a real decision', async () => {
      const learning = await decision('s1k2', 'A learning', {}, { origin: { kind: 'mined' } });
      const manual = await decision('s1k3', 'A learning held by a person', {}, { origin: { kind: 'submitted' } });
      const real = await decision('s1k1', 'Which store holds the widgets: Postgres or DynamoDB?');
      const made = await create();
      // Held at creation by the learning, as the bug did it.
      const entry = store.state.globs.get(made.id);
      if (entry === undefined) throw new Error('no glob');
      store.state.globs.set(made.id, { ...entry, glob: { ...entry.glob, status: 'planning', waiting: { since: '2026-10-05T12:00:00.000Z' } } });
      const held = made;
      const base = { boardId, dismissedPlanHash: null, from: held.id, gate: 'start' as const, until: 'decided' as const, reason: null, evidence: [], createdAt: '2026-10-05T12:00:00.000Z', dismissedAt: null, overriddenAt: null, group: null };
      let n = 0;
      await store.transaction(async (tx) => {
        for (const [to, source] of [[learning.id, 'inferred'], [manual.id, 'person'], [real.id, 'inferred']] as const)
          await tx.insertRelation({ ...base, id: `rel-${String(++n)}`, to, source });
      });
      expect(await inference.dismissLearningHolds(boardId)).toBe(1);
      // Only the person's relation still holds, so it stays held; the learning's no longer does.
      expect((await current(held.id)).waiting).not.toBeNull();
      const by = (to: string) => [...store.state.relations.values()].find((r) => r.from === held.id && r.to === to);
      expect(by(learning.id)?.dismissedAt).not.toBeNull();
      expect(by(manual.id)?.dismissedAt).toBeNull();
      expect(by(real.id)?.dismissedAt).toBeNull();
      expect(await inference.dismissLearningHolds(boardId)).toBe(0);
    });

    it('the cleanup starts a glob that only a learning held', async () => {
      const learning = await decision('s1k2', 'A learning', {}, { origin: { kind: 'mined' } });
      const held = await create();
      const entry = store.state.globs.get(held.id);
      if (entry === undefined) throw new Error('no glob');
      store.state.globs.set(held.id, { ...entry, glob: { ...entry.glob, status: 'planning', waiting: { since: '2026-10-05T12:00:00.000Z' } } });
      await store.transaction((tx) =>
        tx.insertRelation({ id: 'rel-1', boardId, from: held.id, to: learning.id, gate: 'start', until: 'decided', reason: null, evidence: [], source: 'inferred', group: null, dismissedAt: null, dismissedPlanHash: null, overriddenAt: null, createdAt: '2026-10-05T12:00:00.000Z' }),
      );
      expect(await inference.dismissLearningHolds(boardId)).toBe(1);
      expect((await current(held.id)).waiting ?? null).toBeNull();
    });

    it('an investigator finding on a decision refines the model\'s edge but never adds one without the quoted question', () => {
      const open = new Set(['s1k1']);
      const finding = { to: 's1k1', gate: 'start' as const, until: 'decided' as const, reason: 'plan relies on it', files: [] };
      expect(refineEdges([], [finding], open, open)).toEqual([]);
      const model = [{ id: 's1k1', kind: 'decision' as const, reason: 'open', files: [] }];
      expect(refineEdges(model, [finding], open, open)).toEqual([expect.objectContaining({ id: 's1k1', kind: 'decision', reason: 'plan relies on it' })]);
    });
  });
});
