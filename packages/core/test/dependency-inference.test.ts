import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { DependencyInferenceService, parseEdges } from '../src/app/dependency-inference-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import type { Result } from '../src/domain/errors.js';
import type { Glob } from '../src/domain/types.js';
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
  const edges = (...items: { id: string; kind: string; reason?: string }[]): (() => string) => () =>
    JSON.stringify({ edges: items.map((i) => ({ reason: 'uses humanSteps() from it', files: ['a.ts'], ...i })) });

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
  /** A glob's edges as its document used to hold them: its needs (start relations, with their reason as evidence), then its predicted overlaps. */
  const edgesOf = (g: Glob) => [
    ...[...store.state.relations.values()]
      .filter((r) => r.from === g.id && r.gate === 'start')
      .map((r) => ({
        id: r.to,
        kind: 'needs' as const,
        source: r.source,
        paths: r.evidence,
        ...(r.reason === null ? {} : { evidence: r.reason }),
        ...(r.dismissedAt !== null || r.overriddenAt !== null ? { overridden: true as const } : {}),
      })),
    ...(g.impliedAfter ?? []),
  ];
  const create = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrap(await globs.create(DEV, input(patch)));
  const current = async (id: string): Promise<Glob> => {
    const found = await globs.peek(id);
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
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
    inference = new DependencyInferenceService({ store, llm, apply: (id, found, hash) => globs.applyInferred(id, found, hash) });
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

  it('infers needs and overlaps at create, each with its reason, and a need holds a sub', async () => {
    const provider = await create({ type: 'same' });
    const sibling = await create({ type: 'same' });
    answer = edges({ id: provider.id, kind: 'needs', reason: `uses humanSteps() from ${provider.id}` }, { id: sibling.id, kind: 'overlaps', reason: 'both edit glob-dialog.tsx' });
    const made = await create();
    const byId = new Map(edgesOf(made).map((e) => [e.id, e]));
    expect(byId.get(provider.id)).toMatchObject({ kind: 'needs', source: 'inferred', evidence: `uses humanSteps() from ${provider.id}` });
    expect(byId.get(sibling.id)).toMatchObject({ kind: 'overlaps', source: 'inferred', evidence: 'both edit glob-dialog.tsx' });
    expect(made.status).toBe('planning');
    expect(unwrap(await globs.get(DEV, made.id)).waitingFor.map((w) => w.id)).toEqual([provider.id]);
    expect(prompts.at(-1)?.spend).toMatchObject({ boardId, source: 'dependency_inference' });
  });

  it('ignores globs the model made up, unknown kinds and answers without a reason', async () => {
    const other = await create({ type: 'same' });
    answer = edges({ id: 's99t1', kind: 'needs' }, { id: other.id, kind: 'blocks' }, { id: other.id, kind: 'needs', reason: '' });
    expect(edgesOf(await create())).toEqual([]);
    expect(parseEdges('not json', new Set([other.id]))).toBeNull();
    expect(parseEdges('{"edges": [', new Set([other.id]))).toBeNull();
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
    answer = edges({ id: a.id, kind: 'overlaps' });
    const made = await create({ type: 'same' });
    expect(edgesOf(made).map((e) => e.id)).toEqual([a.id]);
    answer = edges({ id: a.id, kind: 'needs', reason: 'uses its helper' }, { id: b.id, kind: 'overlaps' });
    await inference.refresh(made.id);
    const refined = await current(made.id);
    expect(edgesOf(refined).map((e) => [e.id, e.kind])).toEqual([[a.id, 'needs'], [b.id, 'overlaps']]);
    // The need is a relation (logged as one); the overlap changes are logged as inferred edges.
    expect(store.state.events.find((e) => e.globId === made.id && e.type === 'RelationAdded' && e.data['to'] === a.id && e.data['source'] === 'inferred')).toBeDefined();
    expect(store.state.events.find((e) => e.globId === made.id && e.type === 'EdgesInferred' && Array.isArray(e.data['added']) && e.data['added'].length === 1)).toBeDefined();
    answer = edges({ id: c.id, kind: 'overlaps' });
    await inference.refresh(made.id);
    expect(edgesOf(await current(made.id)).map((e) => e.id)).toEqual([c.id]);
    // The same answer again changes nothing.
    const version = (await current(made.id)).version;
    await inference.refresh(made.id);
    expect((await current(made.id)).version).toBe(version);
  });

  it('the investigation refines the edges with the code it read: confirms, adds, and drops a need it found unused', async () => {
    const a = await create({ type: 'same' });
    const b = await create({ type: 'same' });
    const c = await create({ type: 'same' });
    answer = edges({ id: a.id, kind: 'needs', reason: 'guessed from the plan' }, { id: b.id, kind: 'overlaps', reason: 'both edit one file' });
    const made = await create({ type: 'same' });
    expect(edgesOf(made).map((e) => [e.id, e.kind])).toEqual([[a.id, 'needs'], [b.id, 'overlaps']]);
    const investigation = (dependencies: unknown) =>
      `# Investigation\n\n\`\`\`investigation\n${JSON.stringify({
        files: [{ path: 'x.ts', change: 'modify' }],
        modules: ['core'],
        expectedLines: { min: 1, max: 5 },
        parts: [],
        riskTier: 'low',
        riskAreas: [],
        needsHuman: { needed: false, reason: null },
        confidence: 'high',
        dependencies,
        planHash: 'p',
        baseCommit: 'c',
      })}\n\`\`\``;
    const push = (content: string) =>
      store.transaction((tx) =>
        tx.insertArtifact({ globId: made.id, kind: 'investigation', label: '', content, link: null, commitSha: null, provenance: { by: 'human', actor: DEV, runId: null, agentSetVersion: null }, createdAt: '2026-10-05T12:02:00.000Z' }),
      );
    // The model still says a needs; the investigator read the code, uses c instead, and found nothing used from a.
    answer = edges({ id: a.id, kind: 'needs', reason: 'guessed again' }, { id: b.id, kind: 'overlaps', reason: 'both edit one file' });
    await push(investigation([{ id: c.id, kind: 'needs', reason: 'calls parseEdges() in dependency-inference-service.ts', files: ['dependency-inference-service.ts'] }, { id: 's99t9', kind: 'needs', reason: 'not on the board' }]));
    await inference.refresh(made.id);
    const refined = edgesOf(await current(made.id));
    expect(refined.map((e) => [e.id, e.kind])).toEqual([[c.id, 'needs'], [b.id, 'overlaps']]);
    expect(refined[0]).toMatchObject({ source: 'inferred', evidence: 'calls parseEdges() in dependency-inference-service.ts', paths: ['dependency-inference-service.ts'] });
    // With no model answer the investigator's findings stand on their own.
    const lone = new DependencyInferenceService({ store, apply: (id, found, planHash) => globs.applyInferred(id, found, planHash) });
    await push(investigation([{ id: a.id, kind: 'overlaps', reason: 'edits the same function' }]));
    await lone.refresh(made.id);
    // The recorded overlap on b is not the investigator's to drop: it is kept beside the new finding.
    expect(edgesOf(await current(made.id)).map((e) => [e.id, e.kind])).toEqual([[a.id, 'overlaps'], [b.id, 'overlaps']]);
    // Looked and found none, or named only a glob that is not a candidate, with no model: the recorded edges are left alone.
    await push(investigation([]));
    await lone.refresh(made.id);
    expect(edgesOf(await current(made.id)).map((e) => [e.id, e.kind])).toEqual([[a.id, 'overlaps'], [b.id, 'overlaps']]);
    await push(investigation([{ id: 's99t9', kind: 'needs', reason: 'made up' }]));
    await lone.refresh(made.id);
    expect(edgesOf(await current(made.id)).map((e) => [e.id, e.kind])).toEqual([[a.id, 'overlaps'], [b.id, 'overlaps']]);
    // The same when the model's answer is garbled.
    answer = () => 'not json';
    await push(investigation([]));
    await inference.refresh(made.id);
    expect(edgesOf(await current(made.id)).map((e) => [e.id, e.kind])).toEqual([[a.id, 'overlaps'], [b.id, 'overlaps']]);
  });

  it('a dismissed edge is not inferred again until the plan changes', async () => {
    const provider = await create({ type: 'same' });
    answer = edges({ id: provider.id, kind: 'needs' });
    const made = await create();
    const dismissed = unwrap(await globs.dismissEdge(DEV, made.id, made.version, provider.id));
    expect(edgesOf(dismissed)[0]).toMatchObject({ id: provider.id, overridden: true });
    await inference.refresh(made.id);
    const same = await current(made.id);
    expect(edgesOf(same)).toHaveLength(1);
    expect(edgesOf(same)[0]).toMatchObject({ overridden: true });
    // The investigation pushed on the same plan does not bring it back either.
    await inference.refresh(made.id);
    expect(edgesOf(await current(made.id))[0]).toMatchObject({ overridden: true });
    await savePlan(made.id, `${PLAN} It now also reads the helper from ${provider.id}'s change.`);
    await inference.refresh(made.id);
    const again = await current(made.id);
    // Dismissing started the glob, so the need is kept as an overlap (internal data); the dismissed relation stays as it was.
    expect(again.impliedAfter).toHaveLength(1);
    expect(again.impliedAfter?.[0]).toMatchObject({ id: provider.id, kind: 'overlaps', source: 'inferred' });
    expect(again.impliedAfter?.[0]?.overridden).toBeUndefined();
    expect(edgesOf(again)[0]).toMatchObject({ id: provider.id, kind: 'needs', overridden: true });
  });

  it('never creates a cycle: a need on a glob that already waits for this one is dropped with a note', async () => {
    const first = await create({ type: 'same' });
    const second = await create({ type: 'same', after: [first.id] });
    answer = edges({ id: second.id, kind: 'needs', reason: 'uses its endpoint' });
    await inference.refresh(first.id);
    const after = await current(first.id);
    expect(edgesOf(after)).toEqual([]);
    // The need is refused, and with nothing else to record there is no event to say so; an overlap is still fine.
    answer = edges({ id: second.id, kind: 'overlaps', reason: 'both edit one file' });
    await inference.refresh(first.id);
    expect(edgesOf(await current(first.id))[0]).toMatchObject({ id: second.id, kind: 'overlaps' });
  });

  it('a glob that has started keeps needs as overlaps, so nothing blocks it', async () => {
    const provider = await create({ type: 'same' });
    const running = await create({ type: 'sub', after: [] });
    expect(running.status).toBe('implementing');
    answer = edges({ id: provider.id, kind: 'needs', reason: 'uses its helper' });
    await inference.refresh(running.id);
    expect(edgesOf(await current(running.id))[0]).toMatchObject({ id: provider.id, kind: 'overlaps', source: 'inferred' });
  });

  it('an unparseable or cut-off answer leaves the edges as they were; only a well-formed empty list clears them', async () => {
    const other = await create({ type: 'same' });
    answer = edges({ id: other.id, kind: 'overlaps' });
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
    const made = await create();
    const oldHash = hash(PLAN);
    await savePlan(made.id, `${PLAN} Changed meanwhile.`);
    await globs.applyInferred(made.id, [{ id: provider.id, kind: 'overlaps', reason: 'x', files: [] }], oldHash);
    expect(edgesOf(await current(made.id))[0]).toMatchObject({ id: provider.id, kind: 'needs' });
  });

  it('a model that fails leaves the edges as they were', async () => {
    const other = await create({ type: 'same' });
    answer = edges({ id: other.id, kind: 'overlaps' });
    const made = await create({ type: 'same' });
    answer = () => {
      throw new Error('model down');
    };
    await inference.refresh(made.id);
    expect(edgesOf(await current(made.id)).map((e) => e.id)).toEqual([other.id]);
  });
});
