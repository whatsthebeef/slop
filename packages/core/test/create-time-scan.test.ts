import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput, RelationScanTrigger } from '../src/app/glob-service.js';
import type { Llm } from '../src/app/intake-service.js';
import { RelationScanService } from '../src/app/relation-scan-service.js';
import type { CreateDecision, CreatePrerequisite } from '../src/app/relation-scan-service.js';
import type { Result } from '../src/domain/errors.js';
import * as machine from '../src/domain/machine.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const NOW = '2026-10-05T12:00:00.000Z';

describe('create-time relation scan', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let boardId: number;
  let classifyCalls: Parameters<NonNullable<RelationScanTrigger['classifyAtCreate']>>[0][];
  let answer: { prerequisites: CreatePrerequisite[]; decided: CreateDecision[] } | Error;
  let remembered: { globId: string; decided: readonly CreateDecision[] }[];
  let scanRequests: string[];

  const trigger: RelationScanTrigger = {
    request: (input) => {
      scanRequests.push(input.globId);
    },
    classifyAtCreate: (input) => {
      classifyCalls.push(input);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    remember: (globId, _boardId, decided) => {
      remembered.push({ globId, decided });
      return Promise.resolve();
    },
  };

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Hand over the profile',
    type: 'sub',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });
  const create = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> => unwrap(await globs.create(ADMIN, input(patch)));
  const relationsOf = (id: string) => [...store.state.relations.values()].filter((r) => r.from === id);
  const prerequisite = (id: string, sentence: string): CreatePrerequisite => ({ id, gate: 'start', until: 'merged', reason: sentence, sentence });

  const build = (scan: RelationScanTrigger): GlobService => {
    const notifier = new RecordingNotifier();
    let runs = 0;
    return new GlobService({
      store,
      notifier,
      clock: { now: () => NOW },
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
      relationScan: scan,
    });
  };

  beforeEach(async () => {
    store = new MemoryStore();
    classifyCalls = [];
    remembered = [];
    scanRequests = [];
    answer = { prerequisites: [], decided: [] };
    globs = build(trigger);
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    boardId = unwrap(await new BoardService({ store, notifier: new RecordingNotifier() }).create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [] })).id;
  });

  it('creates a sub waiting, with an automatic relation and no run, when its plan says it needs an open glob', async () => {
    const first = await create({ type: 'same', title: 'The prerequisite' });
    const sentence = `Only after ${first.id} has merged do we hand the profile over.`;
    answer = { prerequisites: [prerequisite(first.id, sentence)], decided: [] };
    const sub = await create({ plan: `Hand the profile to sessions. ${sentence}` });
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]).toMatchObject({ boardId, actorEmail: ADMIN, explicitIds: [] });
    expect(relationsOf(sub.id)).toEqual([expect.objectContaining({ to: first.id, gate: 'start', until: 'merged', source: 'mention', reason: sentence })]);
    expect(sub.status).toBe('planning');
    expect(sub.waiting).not.toBeNull();
    expect(sub.provisioning).toBe('none');
    expect(sub.runs).toEqual([]);
  });

  it('skips a prerequisite that holds nothing any more, rather than failing the create', async () => {
    const first = await create({ type: 'same', title: 'Done already' });
    unwrap(await globs.applyEvent(first.id, (g, c) => machine.merged(g, { sha: 'abc123' }, c)));
    const sentence = `Only after ${first.id} has merged do we hand the profile over.`;
    answer = { prerequisites: [prerequisite(first.id, sentence)], decided: [] };
    const sub = await create({ plan: sentence });
    expect(relationsOf(sub.id).filter((r) => r.source === 'mention')).toEqual([]);
  });

  it('skips a prerequisite on a glob that does not exist or that is the new glob itself', async () => {
    answer = { prerequisites: [prerequisite('s1t99', 'Only after s1t99 has merged.')], decided: [] };
    const sub = await create({ plan: 'Only after s1t99 has merged.' });
    expect(relationsOf(sub.id)).toEqual([]);
  });

  it('still creates the glob when the classifier fails, with no automatic relation', async () => {
    const first = await create({ type: 'same' });
    answer = new Error('model down');
    const sub = await create({ plan: `Only after ${first.id} has merged.` });
    expect(sub.id).not.toBe(first.id);
    expect(relationsOf(sub.id)).toEqual([]);
    // The pass the create queues picks it up later.
    expect(scanRequests).toContain(sub.id);
  });

  it('asks nothing when every glob the plan names is stated in after, relations, holds or supersedes', async () => {
    const [a, b, c, d] = [await create({ type: 'same' }), await create({ type: 'same' }), await create({ type: 'same' }), await create({ type: 'same' })];
    await create({
      plan: `After ${a.id} merged. Also ${b.id}, ${c.id} and ${d.id}.`,
      after: [a.id],
      relations: [{ to: b.id, gate: 'sign_off', reason: 'why' }],
      holds: [{ id: c.id, reason: 'why' }],
      supersedes: [{ id: d.id, reason: 'why' }],
      by: 'person',
    });
    expect(classifyCalls).toHaveLength(0);
  });

  it('asks nothing when the plan names no glob', async () => {
    await create({ plan: 'Hand the profile to sessions.' });
    expect(classifyCalls).toHaveLength(0);
  });

  it('remembers what was decided once the glob has an ID', async () => {
    const first = await create({ type: 'same' });
    const sentence = `After ${first.id} merged we removed the token.`;
    answer = { prerequisites: [], decided: [{ id: first.id, sentence, decision: 'history' }] };
    const sub = await create({ plan: sentence });
    expect(remembered).toEqual([{ globId: sub.id, decided: [expect.objectContaining({ id: first.id, decision: 'history' })] }]);
  });

  describe('with the real service', () => {
    let modelCalls: number;
    const llm: Llm = {
      complete: () => {
        modelCalls += 1;
        return Promise.resolve('{"decisions": []}');
      },
    };

    beforeEach(() => {
      modelCalls = 0;
      const scan = new RelationScanService({
        store,
        clock: { now: () => NOW },
        llm,
        automatic: { applyAutomatic: () => Promise.reject(new Error('not used at create')) },
      });
      globs = build(scan);
    });

    it('makes no extra model call when intake already answered, and uses its prerequisites', async () => {
      const first = await create({ type: 'same', title: 'The prerequisite' });
      const request = `Hand the profile to sessions. Only after ${first.id} is in place.`;
      const sub = await create({
        plan: request,
        intake: { request, source: 'web', categoryConfidence: 'high', reason: null, model: 'haiku', promptVersion: 2, examples: [], prerequisites: [{ id: first.id, gate: 'start', sentence: `Only after ${first.id} is in place.` }] },
      });
      expect(modelCalls).toBe(0);
      expect(relationsOf(sub.id)).toEqual([expect.objectContaining({ to: first.id, gate: 'start', source: 'mention', reason: `Only after ${first.id} is in place.` })]);
    });

    it('makes no call at all for an intake answer of no prerequisites', async () => {
      const first = await create({ type: 'same' });
      const request = `After ${first.id} merged we removed the token.`;
      const sub = await create({ plan: request, intake: { request, source: 'web', categoryConfidence: 'high', reason: null, model: 'haiku', promptVersion: 2, examples: [] } });
      expect(modelCalls).toBe(0);
      expect(relationsOf(sub.id)).toEqual([]);
    });
  });
});
