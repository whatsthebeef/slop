import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { LlmRequest } from '../src/app/intake-service.js';
import { RelationScanService } from '../src/app/relation-scan-service.js';
import { hash } from '../src/app/text-hash.js';
import type { Result } from '../src/domain/errors.js';
import { RELATION_SCAN_DEBOUNCE_MS } from '../src/domain/events.js';
import { globIdsIn, quoteReason, sentenceHash } from '../src/domain/relation-scan.js';
import type { AutomaticAdd, AutomaticResult, RelationScanRow } from '../src/domain/relation-scan.js';
import type { Glob, Relation, RelationGate, Status } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const DEV = 'dev@example.com';
const STRANGER = 'stranger@example.com';
const NOW = '2026-10-05T12:00:00.000Z';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

type Rule = (sentence: string, id: string) => { verdict: 'prerequisite' | 'history' | 'context' | 'unsure'; gate: RelationGate };

describe('relation scan', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let scan: RelationScanService;
  let boardId: number;
  let requests: LlmRequest[];
  let reply: (request: LlmRequest) => string;
  let applied: { globId: string; planHash: string; adds: readonly AutomaticAdd[]; actor: string | null }[];
  let applyResult: (adds: readonly AutomaticAdd[]) => AutomaticResult;
  let writeRows: boolean;

  /** The model, answering each (sentence, id) in the prompt by `rule`. */
  const answering =
    (rule: Rule) =>
    (request: LlmRequest): string => {
      const shown = [...request.prompt.matchAll(/^\[(\d+)\] (.*)$/gm)];
      const decisions = shown.flatMap((m) => globIdsIn(m[2] ?? '').map((id) => ({ id, sentence: Number(m[1]), ...rule(m[2] ?? '', id) })));
      return JSON.stringify({ decisions });
    };

  const rows = async (globId: string): Promise<RelationScanRow[]> => store.transaction((tx) => tx.listRelationScans(globId));
  const jobs = () => store.state.outboxJobs.filter((j) => j.kind === 'scan_relations');

  const create = async (title: string): Promise<Glob> =>
    unwrap(await globs.create(DEV, { boardId, title, type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));

  const setStatus = (id: string, status: Status): void => {
    const entry = store.state.globs.get(id);
    if (entry === undefined) throw new Error(`no glob ${id}`);
    store.state.globs.set(id, { ...entry, glob: { ...entry.glob, status } });
  };

  const planOf = async (id: string): Promise<string> => (await store.transaction((tx) => tx.artifactVersions(id, 'plan', ''))).at(-1)?.content ?? '';
  const plan = async (id: string, text: string): Promise<void> => {
    unwrap(await artifacts.putPlan(DEV, id, text));
  };

  const relation = (patch: Partial<Relation> & Pick<Relation, 'id' | 'from' | 'to'>): Relation => ({
    boardId,
    gate: 'sign_off',
    until: 'merged',
    reason: 'because',
    evidence: [],
    source: 'person',
    group: null,
    dismissedAt: null,
    dismissedPlanHash: null,
    overriddenAt: null,
    createdAt: NOW,
    ...patch,
  });

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: DEV, active: true });
      await tx.upsertUser({ email: STRANGER, name: STRANGER, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(DEV, { name: 'Board one', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    let n = 0;
    globs = new GlobService({ store, notifier, clock: { now: () => NOW }, ids: { runId: () => `r${String(++n)}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    requests = [];
    reply = answering(() => ({ verdict: 'context', gate: 'sign_off' }));
    applied = [];
    writeRows = false;
    applyResult = (adds) => ({ added: adds.map((a) => a.to), skipped: [], stale: false });
    scan = new RelationScanService({
      store,
      clock: { now: () => NOW },
      llm: {
        complete: (request) => {
          requests.push(request);
          return Promise.resolve(reply(request));
        },
      },
      automatic: {
        applyAutomatic: async (globId, planHash, adds, actor) => {
          applied.push({ globId, planHash, adds, actor });
          if (writeRows)
            await store.transaction(async (tx) => {
              for (const a of adds) await tx.insertRelation(relation({ id: `auto-${a.to}`, from: globId, to: a.to, gate: a.gate, source: 'auto', reason: a.reason }));
            });
          return applyResult(adds);
        },
      },
      model: 'haiku',
    });
    artifacts = new ArtifactService({ store, clock: { now: () => NOW }, notifier, relationScan: scan });
  });

  afterEach(() => vi.useRealTimers());

  describe('the pass decides from the sentence', () => {
    it('a push-mode step "after the board 15 glob is deployed" adds a sign_off relation with the quoted sentence as its reason', async () => {
      const me = await create('Turn on push mode');
      const target = await create('Deploy board 15');
      const sentence = `Turn on push mode for board 14, after the board 15 glob ${target.id} is deployed.`;
      unwrap(await globs.addHumanStep(DEV, me.id, null, { title: sentence, kind: 'rollout' }));
      reply = answering(() => ({ verdict: 'prerequisite', gate: 'sign_off' }));

      expect(await scan.run(me.id)).toBe('done');

      expect(requests).toHaveLength(1);
      expect(applied).toEqual([{ globId: me.id, planHash: hash(await planOf(me.id)), adds: [{ to: target.id, gate: 'sign_off', until: 'merged', reason: sentence, sentence }], actor: DEV }]);
      expect(await rows(me.id)).toEqual([expect.objectContaining({ mentionedId: target.id, decision: 'added', state: 'done', gate: 'sign_off', reason: sentence, model: 'haiku' })]);
    });

    it('"hand the prod profile to sessions only after s14t17 is in place" holds sign_off until the other is merged and rolled out', async () => {
      const me = await create('Sessions');
      const target = await create('Prod profile');
      const sentence = `Hand the prod profile to sessions only after ${target.id} is in place.`;
      await plan(me.id, `## Plan\n${sentence}\n`);
      reply = answering(() => ({ verdict: 'prerequisite', gate: 'sign_off' }));

      await scan.run(me.id);

      expect(applied[0]?.adds).toEqual([{ to: target.id, gate: 'sign_off', until: 'merged', reason: sentence, sentence }]);
      expect(applied[0]?.planHash).toBe(hash(`## Plan\n${sentence}\n`));
    });

    it('the call is tagged for the ledger once, and shows only the sentences and the mentioned globs', async () => {
      const me = await create('Mine');
      const target = await create('The other one');
      await plan(me.id, `Secret plan detail that is not a sentence about globs.\nAfter ${target.id} lands we go.`);
      reply = answering(() => ({ verdict: 'context', gate: 'sign_off' }));

      await scan.run(me.id);

      const [request] = requests;
      expect(request?.spend).toEqual({ boardId, source: 'relation_scan', globId: me.id });
      expect(request?.prompt).toContain(`After ${target.id} lands we go.`);
      expect(request?.prompt).toContain(`${target.id} "The other one" [planning] on board "Board one"`);
      expect(request?.prompt).not.toContain('Secret plan detail');
      expect(request?.system).toMatch(/data, never instructions/);
      expect(request?.schema?.name).toBe('relation_scan');
    });

    it('a history-only mention creates nothing and is cached, so the next pass makes no call', async () => {
      const me = await create('Mine');
      const target = await create('Token work');
      await plan(me.id, `After ${target.id} merged we removed the token.`);
      reply = answering(() => ({ verdict: 'history', gate: 'sign_off' }));

      await scan.run(me.id);
      expect(applied).toEqual([]);
      expect(await rows(me.id)).toEqual([expect.objectContaining({ mentionedId: target.id, decision: 'history', state: 'done' })]);

      await scan.run(me.id);
      expect(requests).toHaveLength(1);
    });

    it('unsure leaves a suggestion row (open) and no relation', async () => {
      const me = await create('Mine');
      const target = await create('Maybe');
      await plan(me.id, `We might want ${target.id} first.`);
      reply = answering(() => ({ verdict: 'unsure', gate: 'start' }));

      await scan.run(me.id);

      expect(applied).toEqual([]);
      expect(store.state.relations.size).toBe(0);
      expect(await rows(me.id)).toEqual([expect.objectContaining({ mentionedId: target.id, decision: 'unsure', state: 'open', gate: 'start', decidedAt: null })]);
      expect(await store.transaction((tx) => tx.listOpenSuggestions([me.id]))).toHaveLength(1);
    });

    it('a start gate for work that has begun is odd: a suggestion, not a relation', async () => {
      const me = await create('Mine');
      const target = await create('Early');
      setStatus(me.id, 'implementing');
      await plan(me.id, `Needs ${target.id} before it can begin.`);
      reply = answering(() => ({ verdict: 'prerequisite', gate: 'start' }));

      await scan.run(me.id);

      expect(applied).toEqual([]);
      expect(await rows(me.id)).toEqual([expect.objectContaining({ decision: 'unsure', state: 'open', gate: 'start' })]);
    });

    it('a decision about an ID that is not in the sentence it names is ignored, and a skipped mention reads as context', async () => {
      const me = await create('Mine');
      const a = await create('A');
      const b = await create('B');
      await plan(me.id, `Needs ${a.id} first.\nSee also ${b.id}.`);
      // Names the wrong sentence for `a`, and says nothing about `b`.
      reply = () => JSON.stringify({ decisions: [{ id: a.id, sentence: 1, verdict: 'prerequisite', gate: 'start' }] });

      await scan.run(me.id);

      expect(applied).toEqual([]);
      expect((await rows(me.id)).map((r) => [r.mentionedId, r.decision]).sort()).toEqual([[a.id, 'context'], [b.id, 'context']].sort());
    });

    it('exactly one call for several mentions in one pass, and an add per prerequisite', async () => {
      const me = await create('Mine');
      const ids = [await create('One'), await create('Two'), await create('Three')];
      await plan(me.id, `Only after ${ids[0]?.id} is in place.\nWait for ${ids[1]?.id} first.\nSee ${ids[2]?.id} for background.`);
      reply = answering((s) => (s.includes('background') ? { verdict: 'context', gate: 'sign_off' } : { verdict: 'prerequisite', gate: 'merge' }));

      await scan.run(me.id);

      expect(requests).toHaveLength(1);
      expect(applied).toHaveLength(1);
      expect(applied[0]?.adds.map((a) => [a.to, a.gate])).toEqual([[ids[0]?.id, 'merge'], [ids[1]?.id, 'merge']]);
      expect(await rows(me.id)).toHaveLength(3);
    });

    it('more sentences than one call takes: the first 20 are asked, the rest wait for the next pass', async () => {
      const me = await create('Mine');
      const target = await create('T');
      await plan(me.id, Array.from({ length: 25 }, (_, i) => `Line ${String(i)} see ${target.id}.`).join('\n'));

      await scan.run(me.id);

      expect(requests).toHaveLength(1);
      expect([...(requests[0]?.prompt.matchAll(/^\[\d+\] /gm) ?? [])]).toHaveLength(20);
      expect(await rows(me.id)).toHaveLength(20);
      expect(jobs()).toHaveLength(1);
    });
  });

  describe('no usable answer', () => {
    const setUp = async () => {
      const me = await create('Mine');
      const target = await create('T');
      await plan(me.id, `Only after ${target.id} is in place.`);
      return me;
    };

    it.each([
      ['the call throws', () => Promise.reject(new Error('boom'))],
      ['the model is unavailable', () => Promise.reject(new LlmUnavailable('AWS sign-in expired', 'Sign in'))],
      ['the reply is a refusal', () => Promise.resolve("I can't help with that.")],
      ['the reply is cut off', () => Promise.resolve('{"decisions": [{"id": "s1t2", "sentence": 0, "verd')],
      ['the reply has no list', () => Promise.resolve('{"decisions": null}')],
    ])('writes nothing when %s, and a later pass with an answer decides', async (_name, fail) => {
      const me = await setUp();
      const failing = new RelationScanService({
        store,
        clock: { now: () => NOW },
        llm: { complete: fail },
        automatic: { applyAutomatic: () => Promise.reject(new Error('must not write')) },
      });

      await expect(failing.run(me.id)).rejects.toThrow();
      expect(await rows(me.id)).toEqual([]);
      expect(applied).toEqual([]);

      reply = answering(() => ({ verdict: 'prerequisite', gate: 'sign_off' }));
      await scan.run(me.id);
      expect(applied).toHaveLength(1);
    });

    it('no model configured: nothing is written and the pass throws so the outbox retries', async () => {
      const me = await setUp();
      const bare = new RelationScanService({ store, clock: { now: () => NOW }, automatic: { applyAutomatic: () => Promise.reject(new Error('must not write')) } });
      await expect(bare.run(me.id)).rejects.toThrow(/No model/);
      expect(await rows(me.id)).toEqual([]);
    });

    it('a well-formed empty answer is an answer: the mention is remembered as not a prerequisite', async () => {
      const me = await setUp();
      reply = () => JSON.stringify({ decisions: [] });
      await scan.run(me.id);
      expect(await rows(me.id)).toEqual([expect.objectContaining({ decision: 'context', state: 'done' })]);
    });

    it('the pass stays quiet for deterministic items too: nothing is written when the model call fails', async () => {
      const me = await create('Mine');
      const gone = await create('Gone');
      const asked = await create('Asked');
      setStatus(gone.id, 'signed_off');
      await plan(me.id, `After ${gone.id} merged we cleaned up.\nOnly after ${asked.id} is in place.`);
      reply = () => 'nonsense';
      await expect(scan.run(me.id)).rejects.toThrow();
      expect(await rows(me.id)).toEqual([]);
    });
  });

  describe('zero model calls', () => {
    it('no glob ID in the new text: nothing is queued', async () => {
      const me = await create('Mine');
      await plan(me.id, 'Just a plan with no ids in it.');
      await scan.request({ globId: me.id, newText: 'Plan v2 without any glob id.', prevText: 'Plan v1.' });
      expect(jobs()).toEqual([]);
      expect(requests).toEqual([]);
    });

    it('the ID was already in the old text: not a new sentence, nothing is queued', async () => {
      await scan.request({ globId: 's1t1', newText: 'Waits for s1t2.\nAnd more words.', prevText: 'Waits for s1t2.' });
      expect(jobs()).toEqual([]);
    });

    it('a pass over a glob with no ids in any text (a job queued before an edit) makes no call', async () => {
      const me = await create('Mine');
      await plan(me.id, 'Nothing to see here.');
      expect(await scan.run(me.id)).toBe('dropped');
      expect(requests).toEqual([]);
    });

    it('ids that only an explicit relation row names: no call, no write', async () => {
      const me = await create('Mine');
      const target = await create('T');
      await store.transaction((tx) => tx.insertRelation(relation({ id: 'rel-1', from: me.id, to: target.id, gate: 'start' })));
      await plan(me.id, `Waits for ${target.id} to merge.`);
      await scan.run(me.id);
      expect(requests).toEqual([]);
      expect(applied).toEqual([]);
    });

    it('an already related pair, even a dismissed one, in either direction: no call', async () => {
      const me = await create('Mine');
      const a = await create('A');
      const b = await create('B');
      await store.transaction(async (tx) => {
        await tx.insertRelation(relation({ id: 'rel-a', from: me.id, to: a.id, source: 'auto', dismissedAt: NOW }));
        await tx.insertRelation(relation({ id: 'rel-b', from: b.id, to: me.id }));
      });
      await plan(me.id, `Only after ${a.id} is in place. Also ${b.id} is related.`);
      await scan.run(me.id);
      expect(requests).toEqual([]);
      expect(applied).toEqual([]);
    });

    it('a glob that merged and rolled out holds nothing: remembered as history without a call', async () => {
      const me = await create('Mine');
      const done = await create('Done');
      setStatus(done.id, 'signed_off');
      await plan(me.id, `Only after ${done.id} is in place.`);
      await scan.run(me.id);
      expect(requests).toEqual([]);
      expect(await rows(me.id)).toEqual([expect.objectContaining({ mentionedId: done.id, decision: 'history' })]);
    });

    it('a merged glob whose rollout steps are still open does hold: it is asked about', async () => {
      const me = await create('Mine');
      const merged = await create('Merged with a rollout');
      setStatus(merged.id, 'reviewing');
      unwrap(await globs.addHumanStep(DEV, merged.id, null, { title: 'Roll out the stack', kind: 'rollout', blocks: ['dependants'] }));
      await plan(me.id, `Only after ${merged.id} is in place.`);
      await scan.run(me.id);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.prompt).toContain('[rollout]');
    });

    it('a glob on a board the creator cannot read, and one that does not exist, read as history', async () => {
      const me = await create('Mine');
      const other = unwrap(await new BoardService({ store, notifier: new RecordingNotifier() }).create(STRANGER, { name: 'Secret board', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] }));
      const hidden = unwrap(await new GlobService({ store, notifier: new RecordingNotifier(), clock: { now: () => NOW }, ids: { runId: () => 'x' }, routines: { hasRoutine: () => Promise.resolve(true) } }).create(STRANGER, { boardId: other.id, title: 'Hidden title', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }));
      await plan(me.id, `Only after ${hidden.id} is in place. And after s9t99 too.`);
      await scan.run(me.id);
      expect(requests).toEqual([]);
      expect((await rows(me.id)).map((r) => r.decision)).toEqual(['history', 'history']);
    });

    it('the glob\'s own ID is skipped', async () => {
      const me = await create('Mine');
      await plan(me.id, `This is ${me.id}, see ${me.id}.`);
      await scan.run(me.id);
      expect(requests).toEqual([]);
      expect(await rows(me.id)).toEqual([]);
    });
  });

  describe('deterministic cues', () => {
    it('"fixes s14t14" puts a reverse relation on the other glob, with no model call', async () => {
      const me = await create('The fix');
      const broken = await create('Broken');
      const sentence = `This fixes ${broken.id}.`;
      await plan(me.id, sentence);

      await scan.run(me.id);

      expect(requests).toEqual([]);
      expect(applied[0]?.adds).toEqual([{ to: broken.id, gate: 'sign_off', until: 'merged', reason: sentence, sentence, direction: 'holds_back' }]);
      expect(await rows(me.id)).toEqual([expect.objectContaining({ mentionedId: broken.id, decision: 'added', gate: 'sign_off' })]);
    });

    it('"unblocks" holds a start gate on a glob still in Planning, and sign_off otherwise', async () => {
      const me = await create('Unblocker');
      const waiting = await create('Waiting');
      const running = await create('Running');
      setStatus(running.id, 'implementing');
      await plan(me.id, `It unblocks ${waiting.id}. It also unblocks ${running.id}.`);

      await scan.run(me.id);

      expect(applied[0]?.adds.map((a) => [a.to, a.gate, a.direction])).toEqual([[waiting.id, 'start', 'holds_back'], [running.id, 'sign_off', 'holds_back']]);
    });

    it('a reverse cue on a signed-off glob is history', async () => {
      const me = await create('The fix');
      const done = await create('Done');
      setStatus(done.id, 'signed_off');
      await plan(me.id, `Fixes ${done.id}.`);
      await scan.run(me.id);
      expect(applied).toEqual([]);
      expect(await rows(me.id)).toEqual([expect.objectContaining({ decision: 'history' })]);
    });

    it('"replaces s14t11" is a suggestion only: an open row with no gate, no relation, no call', async () => {
      const me = await create('The new one');
      const old = await create('The old one');
      await plan(me.id, `This replaces ${old.id}.`);

      await scan.run(me.id);

      expect(requests).toEqual([]);
      expect(applied).toEqual([]);
      expect(await rows(me.id)).toEqual([expect.objectContaining({ mentionedId: old.id, decision: 'suggested', state: 'open', gate: null })]);
    });

    it('another ID in the same sentence as a cue still goes to the model', async () => {
      const me = await create('Mine');
      const broken = await create('Broken');
      const prerequisite = await create('Prereq');
      await plan(me.id, `Fixes ${broken.id}, only after ${prerequisite.id} is in place.`);
      reply = answering((_s, id) => ({ verdict: id === prerequisite.id ? 'prerequisite' : 'context', gate: 'sign_off' }));

      await scan.run(me.id);

      expect(requests).toHaveLength(1);
      expect(applied[0]?.adds.map((a) => [a.to, a.direction])).toEqual([[broken.id, 'holds_back'], [prerequisite.id, undefined]]);
    });
  });

  describe('applying', () => {
    it('a plan that changed under the pass (stale) writes nothing and asks for another pass', async () => {
      const me = await create('Mine');
      const target = await create('T');
      await plan(me.id, `Only after ${target.id} is in place.`);
      reply = answering(() => ({ verdict: 'prerequisite', gate: 'sign_off' }));
      applyResult = () => ({ added: [], skipped: [], stale: true });

      expect(await scan.run(me.id)).toBe('done');

      expect(await rows(me.id)).toEqual([]);
      expect(jobs()).toHaveLength(1);
    });

    it('an add the service skipped (would cycle, already related) is remembered as context with its reason', async () => {
      const me = await create('Mine');
      const target = await create('T');
      await plan(me.id, `Only after ${target.id} is in place.`);
      reply = answering(() => ({ verdict: 'prerequisite', gate: 'sign_off' }));
      applyResult = (adds) => ({ added: [], skipped: adds.map((a) => ({ to: a.to, why: 'would make a cycle' })), stale: false });

      await scan.run(me.id);

      expect(await rows(me.id)).toEqual([expect.objectContaining({ decision: 'context', state: 'done', reason: 'would make a cycle' })]);
    });

    it('a dismissal of an automatic relation is remembered across a plan change', async () => {
      const me = await create('Mine');
      const target = await create('T');
      const other = await create('Other');
      const first = `Only after ${target.id} is in place.`;
      await plan(me.id, first);
      reply = answering(() => ({ verdict: 'prerequisite', gate: 'sign_off' }));
      writeRows = true;
      await scan.run(me.id);
      expect(applied).toHaveLength(1);

      // A person dismisses it; the plan then changes and still says it.
      await store.transaction((tx) => tx.updateRelation(`auto-${target.id}`, { dismissedAt: NOW, dismissedPlanHash: hash(first) }));
      await plan(me.id, `${first}\nAnd it also needs ${other.id} in place.\nReworded: wait for ${target.id}, again.`);
      await scan.run(me.id);

      expect(applied).toHaveLength(2);
      expect(applied[1]?.adds.map((a) => a.to)).toEqual([other.id]);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.prompt).not.toContain(`Reworded: wait for ${target.id}`);
    });

    it('a sentence that changes is a new question, a cached one is not asked again', async () => {
      const me = await create('Mine');
      const target = await create('T');
      await plan(me.id, `See ${target.id}.`);
      await scan.run(me.id);
      await plan(me.id, `See ${target.id}.`);
      await scan.run(me.id);
      expect(requests).toHaveLength(1);
      await plan(me.id, `Only after ${target.id} is in place.`);
      await scan.run(me.id);
      expect(requests).toHaveLength(2);
    });
  });

  describe('triggers and the debounce', () => {
    it('10 saves with ids within 30 s are one pending job whose run time keeps moving out', async () => {
      vi.useFakeTimers({ now: new Date('2026-10-05T12:00:00.000Z') });
      const me = await create('Mine');
      const runAfters: string[] = [];
      for (let i = 0; i < 10; i++) {
        await scan.request({ globId: me.id, newText: `Version ${String(i)} waits for s1t2.`, prevText: `Version ${String(i - 1)} waits for s1t2.` });
        runAfters.push(jobs()[0]?.runAfter ?? '');
        vi.advanceTimersByTime(2_000);
      }
      expect(jobs()).toHaveLength(1);
      expect(jobs()[0]?.state).toBe('pending');
      expect(new Date(runAfters[0] ?? '').getTime()).toBe(new Date('2026-10-05T12:00:00.000Z').getTime() + RELATION_SCAN_DEBOUNCE_MS);
      expect(new Date(runAfters[9] ?? '').getTime()).toBe(new Date('2026-10-05T12:00:18.000Z').getTime() + RELATION_SCAN_DEBOUNCE_MS);
      expect(requests).toEqual([]);
    });

    it('saving a plan, an implementation record or a text attachment with a new ID queues one pass; other saves and kinds do not', async () => {
      const me = await create('Mine');
      await plan(me.id, 'A plan with no ids.');
      expect(jobs()).toEqual([]);
      await plan(me.id, 'A plan that waits for s1t2.');
      expect(jobs()).toHaveLength(1);
      // The same sentence again is not new.
      store.state.outboxJobs = [];
      await plan(me.id, 'A plan that waits for s1t2.\nMore words.');
      expect(jobs()).toEqual([]);
      unwrap(await artifacts.putArtifact(DEV, me.id, 'implementation_plan', 'The record: hand over only after s1t3.', { commitSha: null, runId: null, agentSetVersion: null }));
      expect(jobs()).toHaveLength(1);
      store.state.outboxJobs = [];
      unwrap(await artifacts.attach(DEV, me.id, { label: 'notes', text: 'Wait for s1t4.', link: null }));
      expect(jobs()).toHaveLength(1);
      store.state.outboxJobs = [];
      unwrap(await artifacts.attach(DEV, me.id, { label: 'notes', text: 'Wait for s1t4.\nplus a line', link: null }));
      expect(jobs()).toEqual([]);
      unwrap(await artifacts.putArtifact(DEV, me.id, 'local_review', 'Looks at s1t5.', { commitSha: null, runId: null, agentSetVersion: null }));
      expect(jobs()).toEqual([]);
    });

    it('the artifact service without the dependency behaves as before', async () => {
      const bare = new ArtifactService({ store, clock: { now: () => NOW }, notifier: new RecordingNotifier() });
      const me = await create('Mine');
      unwrap(await bare.putPlan(DEV, me.id, 'Waits for s1t2.'));
      expect(jobs()).toEqual([]);
    });
  });

  describe('at create', () => {
    const input = (planText: string, extra: Partial<Parameters<RelationScanService['classifyAtCreate']>[0]> = {}) => ({ boardId, planText, actorEmail: DEV, ...extra });

    it('a plan that names no glob, or only globs the caller stated, makes no call', async () => {
      const target = await create('T');
      expect(await scan.classifyAtCreate(input('Nothing here.'))).toEqual({ prerequisites: [], decided: [] });
      expect(await scan.classifyAtCreate(input(`Only after ${target.id} is in place.`, { explicitIds: [target.id] }))).toEqual({ prerequisites: [], decided: [] });
      expect(requests).toEqual([]);
    });

    it('classifies once, with a start gate allowed, tagged without a glob (it has no ID yet)', async () => {
      const target = await create('T');
      const other = await create('Other');
      reply = answering((s) => (s.includes('Only after') ? { verdict: 'prerequisite', gate: 'start' } : { verdict: 'context', gate: 'sign_off' }));
      const sentence = `Only after ${target.id} is in place.`;

      const result = await scan.classifyAtCreate(input(`${sentence}\nSee ${other.id}.`, { title: 'New work' }));

      expect(requests).toHaveLength(1);
      expect(requests[0]?.spend).toEqual({ boardId, source: 'relation_scan' });
      expect(result.prerequisites).toEqual([{ id: target.id, gate: 'start', until: 'merged', reason: sentence, sentence }]);
      expect(result.decided).toEqual([{ id: other.id, sentence: `See ${other.id}.`, decision: 'context' }]);
    });

    it('what intake already answered stands and no call is made; the rest is remembered once the glob exists', async () => {
      const target = await create('T');
      const other = await create('Other');
      const sentence = `Only after ${target.id} is in place.`;
      const result = await scan.classifyAtCreate(input(`${sentence}\nSee ${other.id}.`, { answered: [{ id: target.id, gate: 'sign_off', sentence }] }));

      expect(requests).toEqual([]);
      expect(result.prerequisites).toEqual([{ id: target.id, gate: 'sign_off', until: 'merged', reason: sentence, sentence }]);
      expect(result.decided).toHaveLength(1);

      const made = await create('New');
      await scan.remember(made.id, boardId, result.decided);
      expect(await rows(made.id)).toEqual([expect.objectContaining({ mentionedId: other.id, decision: 'context', sentenceHash: sentenceHash(`See ${other.id}.`) })]);
    });

    it('a settled target, a fix cue, and an answer that cannot be used add nothing, and it never throws', async () => {
      const done = await create('Done');
      setStatus(done.id, 'signed_off');
      const broken = await create('Broken');
      expect(await scan.classifyAtCreate(input(`Only after ${done.id} is in place. Fixes ${broken.id}.`))).toEqual({ prerequisites: [], decided: [] });
      expect(requests).toEqual([]);

      const live = await create('Live');
      reply = () => 'not json';
      expect(await scan.classifyAtCreate(input(`Only after ${live.id} is in place.`))).toEqual({ prerequisites: [], decided: [] });
      const throwing = new RelationScanService({ store, clock: { now: () => NOW }, llm: { complete: () => Promise.reject(new Error('down')) }, automatic: { applyAutomatic: () => Promise.reject(new Error('no')) } });
      expect(await throwing.classifyAtCreate(input(`Only after ${live.id} is in place.`))).toEqual({ prerequisites: [], decided: [] });
    });
  });

  it('a long sentence is cut in the prompt but remembered whole', async () => {
    const me = await create('Mine');
    const target = await create('T');
    const long = `Only after ${target.id} is in place ${'and so on '.repeat(60)}end.`;
    await plan(me.id, long);
    await scan.run(me.id);
    expect(requests[0]?.prompt).not.toContain('end.');
    expect((await rows(me.id))[0]?.sentence).toBe(long);
    expect(quoteReason(long).length).toBeLessThanOrEqual(240);
  });
});
