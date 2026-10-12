import { kbItems } from '../src/app/kb-items.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/app/artifact-service.js';
import { BoardService } from '../src/app/board-service.js';
import { createDecisionInTx } from '../src/app/decision-glob.js';
import { DecisionGlobService } from '../src/app/decision-glob-service.js';
import type { DecideRequest } from '../src/app/decision-glob-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import { InboxService } from '../src/app/inbox-service.js';
import type { Llm } from '../src/app/intake-service.js';
import { KbPipeline } from '../src/app/kb-pipeline.js';
import { KnowledgeService } from '../src/app/knowledge-service.js';
import type { NewLearning, TargetChange } from '../src/app/knowledge-service.js';
import { isDecisionAttributes } from '../src/domain/attributes.js';
import type { DecisionAttributes } from '../src/domain/attributes.js';
import { decisionOf, isArchivedDecision } from '../src/domain/decision-glob.js';
import type { Result } from '../src/domain/errors.js';
import type { KbItem } from '../src/domain/kb.js';
import * as machine from '../src/domain/machine.js';
import type { Glob } from '../src/domain/types.js';
import type { Catalog } from '../src/ports.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { MemoryKbQueue, TEST_KB_WRITES } from '../src/testing/kb-queue.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const errorCode = (result: Result<unknown>): string | null => (result.ok ? null : result.error.code);

const ADMIN = 'admin@example.com';
const PO = 'po@example.com';
const DEV = 'dev@example.com';
const START = '2026-10-05T12:00:00.000Z';

const IMPLEMENTER = '---\nname: implementer\ndescription: Implements plans\n---\n\n# Implementer\n\n## Rules\n\n- Follow the plan.\n';
const BUILD_DOC = '---\narea: build\naudience: [implementer, tester]\ndescription: Build and test commands\n---\n# Build\n\n## Test\n\nRun vitest.\n\n## Lint\n\nRun eslint.\n';
const catalog: Catalog = {
  kbEntries: () => Promise.resolve([]),
  agentSet: () => Promise.resolve({ hash: 'h1', files: [{ path: 'agents/implementer.md', content: IMPLEMENTER }] }),
};

class FakeLlm implements Llm {
  private readonly answers: string[] = [];
  answer(...answers: string[]): void {
    this.answers.push(...answers);
  }
  complete(): Promise<string> {
    const next = this.answers.shift();
    return next === undefined ? Promise.reject(new Error('No canned answer')) : Promise.resolve(next);
  }
}

const json = (value: unknown) => JSON.stringify(value);
const toNewDoc = (name: string) =>
  json({ target: { kind: 'document', name, section: null, newDocument: { area: 'testing', audience: ['tester'], description: 'How tests run' } }, catalogCandidate: false, catalogReason: null });
const draftAnswer = (section: string | null, content: string) => json({ section, content, rationale: 'Adds the rule' });
const GEN = 'Generated files live in src/gen/';
const GEN_AGAIN = 'Code in src/gen/ is generated';

describe('decision globs', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let knowledge: KnowledgeService;
  let decisions: DecisionGlobService;
  let globs: GlobService;
  let artifacts: ArtifactService;
  let inbox: InboxService;
  let pipeline: KbPipeline;
  let queue: MemoryKbQueue;
  let router: FakeLlm;
  let drafter: FakeLlm;
  let now: string;
  let boardId: number;
  let workId: string;

  const clock = { now: () => now };
  const advance = (ms: number) => {
    now = new Date(Date.parse(now) + ms).toISOString();
  };

  const glob = async (id: string): Promise<Glob> => {
    const found = await store.transaction((tx) => tx.getGlob(id));
    if (found === null) throw new Error(`No glob ${id}`);
    return found;
  };
  const attributesOf = async (id: string): Promise<DecisionAttributes> => {
    const found = decisionOf(await glob(id));
    if (found === null) throw new Error(`${id} is not a decision`);
    return found;
  };
  const item = async (id: string): Promise<KbItem> => {
    const found = await store.transaction((tx) => kbItems(tx).getKbItem(id));
    if (found === null) throw new Error(`No KB item ${id}`);
    return found;
  };
  const doc = async (name: string) => (await store.transaction((tx) => tx.getKnowledge(boardId, 'doc', name)))?.content;
  const artifactsOf = (id: string, kind: 'assessment' | 'plan' | 'attachment') => store.transaction((tx) => tx.listArtifacts(id, kind));
  const assessments = (id: string) => store.transaction((tx) => tx.artifactVersions(id, 'assessment', ''));

  const newWork = async (patch: Partial<CreateGlobInput> = {}): Promise<Glob> =>
    unwrap(
      await globs.create(ADMIN, {
        boardId,
        title: 'Work',
        summary: '',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
        ...patch,
      }),
    );

  const submit = async (patch: Partial<NewLearning> = {}) =>
    unwrap(
      await knowledge.submitLearning(DEV, boardId, {
        sourceGlobId: workId,
        type: 'gotcha',
        statement: GEN,
        evidence: 'Review finding on src/gen/client.ts',
        ...patch,
      }),
    );

  /** Submits an item, points it at the Lint section of the build doc and has the pipeline draft it. */
  const drafted = async (patch: Partial<NewLearning> = {}, answer = draftAnswer('Lint', 'Run eslint --max-warnings 0.')) => {
    const made = await submit(patch);
    const target: TargetChange = { kind: 'doc', name: 'build_test_lint', section: 'Lint' };
    unwrap(await knowledge.changeTarget(ADMIN, made.id, (await item(made.id)).version, target));
    drafter.answer(answer);
    expect(await queue.process(made.id)).toBe(true);
    expect((await item(made.id)).processing).toBe('drafted');
    return made;
  };

  const pickUp = async (id: string, email = ADMIN) => unwrap(await globs.pickUp(email, id, (await glob(id)).version, false));
  const decide = async (id: string, input: DecideRequest, email = ADMIN) => decisions.decide(email, id, (await glob(id)).version, input);
  /** An item picked up and ready to be decided. */
  const inDoing = async (made: { globId: string }, email = ADMIN) => {
    await pickUp(made.globId, email);
    return made.globId;
  };
  const setScope = async (id: string, scope: unknown) => unwrap(await globs.update(ADMIN, id, (await glob(id)).version, { attributes: { scope } }));
  /** Approves the item on the Knowledge page as `learning`: the decision glob follows. */
  const approveOnPage = async (itemId: string) => unwrap(await knowledge.approve(ADMIN, itemId, (await item(itemId)).version, { as: 'learning' }));

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = START;
    router = new FakeLlm();
    drafter = new FakeLlm();
    knowledge = new KnowledgeService({ store, clock, catalog, notifier });
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => 'run-1' }, routines: { hasRoutine: () => Promise.resolve(true) } });
    decisions = new DecisionGlobService({ store, clock, notifier, knowledge, globs });
    artifacts = new ArtifactService({ store, clock, notifier });
    inbox = new InboxService({ store, clock, notifier });
    pipeline = new KbPipeline({ store, clock, catalog, notifier, route: router, draft: drafter });
    queue = new MemoryKbQueue(store, pipeline, clock, notifier);
    const boards = new BoardService({ store, notifier });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, PO, DEV]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'b', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    unwrap(await boards.setMember(ADMIN, boardId, PO, 'po'));
    workId = (await newWork({ title: 'Existing work' })).id;
    unwrap(await knowledge.importDocuments(ADMIN, boardId, [{ fileName: 'build_test_lint.md', content: BUILD_DOC }], 'upload'));
    notifier.hints.length = 0;
  });

  describe('creation', () => {
    it('is a submitted learning itself: Planning, the item\'s fields as attributes, proposal as plan.md, assessment v1', async () => {
      const made = await submit({ type: 'decision' });
      // The glob is the item, under the item's own ID.
      expect(made.globId).toBe('s1k1');
      expect(made.globId).toBe(made.id);
      const g = await glob(made.globId);
      expect(g).toMatchObject({ category: 'decision', type: 'same', status: 'planning', title: GEN, provisioning: 'none', labels: {}, runs: [], doingSince: null, version: 1 });
      expect(g.attributes).toEqual({
        scope: { kind: 'project', ref: null },
        origin: { kind: 'submitted' },
        channel: 'agent',
        outcome: null,
        kind: 'decision',
        sourceGlobs: [workId],
        target: { suggested: null, routed: null },
        evidenceCount: 1,
      });
      expect(await item(made.id)).toMatchObject({ id: made.globId, statement: GEN, version: g.version });
      const [plan] = await artifactsOf(made.globId, 'plan');
      expect(plan?.content).toContain(GEN);
      expect(plan?.content).toContain('Review finding on src/gen/client.ts');
      expect(plan?.provenance.by).toBe('routine');
      const versions = await assessments(made.globId);
      expect(versions).toHaveLength(1);
      expect(versions[0]?.content).toMatch(/Scope: the whole project/);
    });

    it('scopes a non-decision learning to future work by default, and numbers it in the k sequence of the KB items', async () => {
      const made = await submit({ type: 'pattern' });
      expect((await attributesOf(made.globId)).scope).toEqual({ kind: 'future_work', ref: null });
      expect((await submit({ statement: 'Another' })).globId).toBe('s1k2');
      expect((await newWork()).id).toBe('s1t2');
    });

    it('queues no effect for a decision: no branch, no PR, no run', async () => {
      await submit();
      // The only job is the learning's own: routing it, on the KB pipeline's lane.
      const glob_ = () => store.state.outbox.filter((e) => 'globId' in e && e.globId === 's1k1' && e.kind !== 'kb_route');
      expect(store.state.outbox.filter((e) => e.globId === 's1k1').map((e) => e.kind)).toEqual(['kb_route']);
      expect(glob_()).toEqual([]);
      await pickUp('s1k1');
      expect(glob_()).toEqual([]);
      expect(await glob('s1k1')).toMatchObject({ status: 'in_progress', provisioning: 'none', runs: [], implementer: ADMIN });
    });

    it('is idempotent on its creation key', async () => {
      const made = await submit();
      const again = await store.transaction(async (tx) => {
        const board = await tx.getBoard(boardId);
        if (board === null) throw new Error('no board');
        const existing = await tx.findGlobByCreationKey(boardId, `kb:${made.id}`);
        return createDecisionInTx(tx, { clock }, {
          boardId,
          actor: { email: DEV, role: 'dev' },
          title: 'x',
          summary: 'x',
          payload: 'x',
          attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'submitted' }, channel: 'agent', outcome: null },
          creationKey: `kb:${made.id}`,
        }).then((r) => ({ r, existing }));
      });
      expect(again.r.ok && again.r.value.created).toBe(false);
      expect(again.r.ok && again.r.value.glob.id).toBe(made.globId);
      expect(await store.transaction((tx) => tx.listGlobs(boardId, { include: 'decisions' }))).toHaveLength(1);
    });

    it('is refused for a glob scope naming a glob that is not on the board', async () => {
      const result = await store.transaction((tx) =>
        createDecisionInTx(tx, { clock }, {
          boardId,
          actor: { email: DEV, role: 'dev' },
          title: 'x',
          summary: 'x',
          payload: 'x',
          attributes: { scope: { kind: 'glob', ref: 's9t9' }, origin: { kind: 'manual' }, channel: 'human', outcome: null },
          creationKey: 'manual:1',
        }),
      );
      expect(errorCode(result)).toBe('invalid_input');
    });

    it('is refused an explicit id that is not a k ID on its board (s15f36)', async () => {
      const make = (id: string) =>
        store.transaction((tx) =>
          createDecisionInTx(tx, { clock }, {
            boardId,
            actor: { email: DEV, role: 'dev' },
            title: 'x',
            summary: 'x',
            payload: 'x',
            attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'manual' }, channel: 'human', outcome: null },
            id,
            creationKey: `manual:${id}`,
          }),
        );
      for (const id of ['s1d5', 's1t5', `s${String(boardId + 1)}k5`, 'nope']) expect(errorCode(await make(id))).toBe('invalid_input');
      expect(await store.transaction((tx) => tx.listGlobs(boardId, { include: 'decisions' }))).toHaveLength(0);
      const made = await make(`s${String(boardId)}k5`);
      expect(made.ok && made.value.glob.id).toBe(`s${String(boardId)}k5`);
    });

    it('is never made through GlobService.create', async () => {
      const result = await globs.create(ADMIN, {
        boardId,
        title: 'Sneaky',
        summary: '',
        type: 'same',
        category: 'decision',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      });
      expect(errorCode(result)).toBe('invalid_input');
    });
  });

  describe('listing', () => {
    it('leaves decisions out of work listings by default and shows them on request', async () => {
      const made = await submit();
      const list = (include?: 'work' | 'decisions' | 'all') => store.transaction((tx) => tx.listGlobs(boardId, include === undefined ? {} : { include }));
      expect((await list()).map((g) => g.id)).toEqual([workId]);
      expect((await list('work')).map((g) => g.id)).toEqual([workId]);
      expect((await list('decisions')).map((g) => g.id)).toEqual([made.globId]);
      expect((await list('all')).map((g) => g.id).sort()).toEqual([made.globId, workId].sort());
      expect((await store.transaction((tx) => tx.listGlobs(boardId, { include: 'decisions', status: ['in_progress'] })))).toEqual([]);
      expect(unwrap(await globs.list(ADMIN, boardId, {})).map((g) => g.id)).toEqual([workId]);
      expect(unwrap(await globs.list(ADMIN, boardId, { include: 'all' }))).toHaveLength(2);
    });
  });

  describe('the five outcomes', () => {
    it('accept applies the draft to the target and moves the glob to Reviewing', async () => {
      const made = await drafted();
      const id = await inDoing(made);
      const result = unwrap(await decide(id, { outcome: 'accept' }));
      expect(result).toMatchObject({ status: 'reviewing', doingSince: null });
      expect(result.attributes).toMatchObject({ outcome: { kind: 'accept', by: ADMIN, at: now } });
      expect(await doc('build_test_lint')).toContain('Run eslint --max-warnings 0.');
      expect(await item(made.id)).toMatchObject({ status: 'approved', decidedBy: ADMIN, outcome: { kind: 'applied', target: 'doc', name: 'build_test_lint' } });
      expect(notifier.hints).toContainEqual({ kind: 'board.kb', boardId });
      expect(notifier.hints).toContainEqual({ kind: 'glob.changed', boardId, globId: id, version: result.version });
    });

    it('accept with edits applies the edited draft instead', async () => {
      const made = await drafted();
      const id = await inDoing(made);
      expect(errorCode(await decide(id, { outcome: 'accept_with_edits' }))).toBe('invalid_input');
      const result = unwrap(await decide(id, { outcome: 'accept_with_edits', editedDraft: 'Run eslint and tsc.' }));
      expect(result.attributes).toMatchObject({ outcome: { kind: 'accept_with_edits' } });
      expect(await doc('build_test_lint')).toContain('Run eslint and tsc.');
      expect(await doc('build_test_lint')).not.toContain('--max-warnings');
    });

    it('retarget points the item at another target to be drafted again, and the glob stays in Doing', async () => {
      const made = await drafted();
      const id = await inDoing(made);
      const before = await glob(id);
      const result = unwrap(await decide(id, { outcome: 'retarget', target: { kind: 'doc', name: 'build_test_lint', section: 'Test' } }));
      // The retarget is a write to the learning, which is this glob: one version on, still in Doing.
      expect(result).toMatchObject({ status: 'in_progress', version: before.version + 1 });
      expect(await item(made.id)).toMatchObject({ status: 'open', processing: 'routed', draft: null, target: { section: 'Test' } });
      const events = await store.transaction((tx) => tx.listBoardEvents(boardId, '1970-01-01T00:00:00.000Z', ['DecisionDecided']));
      expect(events.map((e) => e.globId)).toEqual([id]);
      expect(errorCode(await decide(id, { outcome: 'retarget' }))).toBe('invalid_input');
    });

    it('reject rejects the item with the reason and signs the glob off, archived', async () => {
      const made = await drafted();
      const id = await inDoing(made);
      expect(errorCode(await decide(id, { outcome: 'reject' }))).toBe('invalid_input');
      const result = unwrap(await decide(id, { outcome: 'reject', reason: 'Already in the lint doc' }));
      expect(result).toMatchObject({ status: 'signed_off', signedOffAt: now });
      expect(isArchivedDecision(result)).toBe(true);
      expect(await item(made.id)).toMatchObject({ status: 'rejected', decisionReason: 'Already in the lint doc', decidedBy: ADMIN });
      expect(await doc('build_test_lint')).not.toContain('--max-warnings');
    });

    it('needs work creates the work glob, links it, and waits; the linked glob merging moves the decision to Reviewing', async () => {
      const made = await drafted();
      const id = await inDoing(made);
      const result = unwrap(await decide(id, { outcome: 'needs_work', reason: 'Also needs the CI change' }));
      expect(result.status).toBe('in_progress');
      const outcome = (await attributesOf(id)).outcome;
      expect(outcome).toMatchObject({ kind: 'needs_work', linkedGlobId: 's1t2' });
      const work = await glob('s1t2');
      expect(work).toMatchObject({ category: 'task', type: 'same', status: 'planning' });
      expect(work.title).toContain(id);
      const [plan] = await artifactsOf('s1t2', 'plan');
      expect(plan?.content).toContain('Also needs the CI change');
      expect(plan?.content).toContain(GEN);
      // The item is untouched while the work happens.
      expect(await item(made.id)).toMatchObject({ status: 'open' });

      expect(await decisions.linkedMerged('s1t9', boardId)).toEqual([]);
      expect(await decisions.linkedMerged('s1t2', boardId)).toEqual([id]);
      expect(await glob(id)).toMatchObject({ status: 'reviewing' });
      expect((await attributesOf(id)).outcome).toMatchObject({ kind: 'needs_work', workLanded: true });
      expect(await decisions.linkedMerged('s1t2', boardId)).toEqual([]);
      // Retrying the decision after the landing creates no second work glob.
      expect((await store.transaction((tx) => tx.listGlobs(boardId, {}))).map((g) => g.id).sort()).toEqual(['s1t1', 's1t2']);
    });

    it('needs work can link an existing board glob, and refuses one that is gone, merged or a decision', async () => {
      const made = await drafted();
      const other = await drafted({ statement: 'Second proposal' });
      const id = await inDoing(made);
      const second = await inDoing(other);
      expect(errorCode(await decide(id, { outcome: 'needs_work', linkedGlobId: 's9t9' }))).toBe('not_found');
      expect(errorCode(await decide(id, { outcome: 'needs_work', linkedGlobId: second }))).toBe('invalid_input');
      const merged = await newWork({ title: 'Merged' });
      await store.transaction(async (tx) => {
        await tx.updateGlob({ ...merged, status: 'signed_off', version: merged.version + 1 }, merged.version);
      });
      expect(errorCode(await decide(id, { outcome: 'needs_work', linkedGlobId: merged.id }))).toBe('invalid_input');
      const result = unwrap(await decide(id, { outcome: 'needs_work', linkedGlobId: workId }));
      expect((await attributesOf(result.id)).outcome).toMatchObject({ linkedGlobId: workId });
      // After needs work the decision can still be decided again.
      expect(unwrap(await decide(id, { outcome: 'reject', reason: 'Dropped' })).status).toBe('signed_off');
    });

    it('refuses an item still being routed, and keeps an item the pipeline gave up on as a learning', async () => {
      const waiting = await submit();
      await pickUp(waiting.globId);
      expect(errorCode(await decide(waiting.globId, { outcome: 'accept' }))).toBe('invalid_input');
      const failed = await submit({ statement: 'Second' });
      queue.fail(failed.id, 'The routing answer was not usable JSON');
      await pickUp(failed.globId);
      expect(unwrap(await decide(failed.globId, { outcome: 'accept' })).status).toBe('reviewing');
      expect(await item(failed.id)).toMatchObject({ status: 'approved', outcome: { kind: 'learning' } });
    });

    it('refuses wrong states, a stale version and non-deciders without touching the item', async () => {
      const made = await drafted();
      expect(errorCode(await decide(made.globId, { outcome: 'accept' }))).toBe('invalid_transition');
      await pickUp(made.globId);
      const seen = await glob(made.globId);
      expect(errorCode(await decide(made.globId, { outcome: 'accept' }, DEV))).toBe('forbidden');
      expect(errorCode(await decisions.decide(ADMIN, made.globId, seen.version - 1, { outcome: 'accept' }))).toBe('version_conflict');
      expect(errorCode(await decisions.decide(ADMIN, workId, 1, { outcome: 'accept' }))).toBe('invalid_input');
      expect(errorCode(await decisions.decide(ADMIN, 's1k99', 1, { outcome: 'accept' }))).toBe('not_found');
      expect(await item(made.id)).toMatchObject({ status: 'open' });
      expect(await doc('build_test_lint')).not.toContain('--max-warnings');
      expect(errorCode(await decide(made.globId, { outcome: 'accept', reason: 'x', linkedGlobId: 's1t1' }))).toBe('invalid_input');
    });

    it('lets a PO decide a documentation item, but not one that changes an agent-set file (they may still reject it)', async () => {
      const docItem = await drafted();
      const id = await inDoing(docItem, PO);
      expect(unwrap(await decide(id, { outcome: 'accept' }, PO)).status).toBe('reviewing');
      expect(await item(docItem.id)).toMatchObject({ status: 'approved', decidedBy: PO });

      const agentItem = await submit({ statement: 'Implementers run the linter', type: 'agent-behaviour' });
      unwrap(await knowledge.changeTarget(ADMIN, agentItem.id, (await item(agentItem.id)).version, { kind: 'agent', name: 'agents/implementer.md', section: null }));
      drafter.answer(draftAnswer(null, '- Run the linter.'));
      await queue.process(agentItem.id);
      const agentGlob = await inDoing(agentItem, PO);
      expect(errorCode(await decide(agentGlob, { outcome: 'accept' }, PO))).toBe('forbidden');
      expect(errorCode(await decide(agentGlob, { outcome: 'retarget', target: { kind: 'agent', name: 'agents/implementer.md', section: 'Rules' } }, PO))).toBe('forbidden');
      expect(await item(agentItem.id)).toMatchObject({ status: 'open' });
      expect(unwrap(await decide(agentGlob, { outcome: 'accept' }, ADMIN)).status).toBe('reviewing');
    });

    it('signs off from Reviewing and reopens to choose again', async () => {
      const added = unwrap(await inbox.add(DEV, boardId, { text: 'We agreed to use a websocket.', title: 'Standup' }));
      const { glob: promoted } = unwrap(await inbox.promote(DEV, boardId, added.id));
      await pickUp(promoted.id);
      unwrap(await decide(promoted.id, { outcome: 'accept' }));
      const reopened = unwrap(await globs.reopenDecision(PO, promoted.id, (await glob(promoted.id)).version));
      expect(reopened).toMatchObject({ status: 'in_progress' });
      expect((await attributesOf(promoted.id)).outcome).toBeNull();
      unwrap(await decide(promoted.id, { outcome: 'accept' }));
      expect(errorCode(await globs.signOffDecision(DEV, promoted.id, (await glob(promoted.id)).version))).toBe('forbidden');
      const signedOff = unwrap(await globs.signOffDecision(PO, promoted.id, (await glob(promoted.id)).version));
      expect(signedOff).toMatchObject({ status: 'signed_off', signedOffAt: now });
      expect(errorCode(await globs.signOffDecision(PO, promoted.id, signedOff.version))).toBe('invalid_transition');
    });

    it('accepting again after a reopen only records the outcome when its item was approved; other outcomes are refused', async () => {
      const made = await drafted();
      const id = await inDoing(made);
      unwrap(await decide(id, { outcome: 'accept' }));
      const approved = await item(made.id);
      const document = await doc('build_test_lint');
      unwrap(await globs.reopenDecision(ADMIN, id, (await glob(id)).version));
      expect(errorCode(await decide(id, { outcome: 'reject', reason: 'Changed my mind' }))).toBe('invalid_input');
      expect(errorCode(await decide(id, { outcome: 'accept_with_edits', editedDraft: 'x' }))).toBe('invalid_input');
      expect(unwrap(await decide(id, { outcome: 'accept' })).status).toBe('reviewing');
      // The learning stays approved as it was: its change is not applied again.
      expect(await item(made.id)).toMatchObject({ status: 'approved', outcome: approved.outcome, decidedBy: approved.decidedBy });
      expect(await doc('build_test_lint')).toBe(document);
    });
  });

  describe('keeping the glob and the item in step', () => {
    it('follows an approval or a rejection made on the Knowledge page, without a pick-up', async () => {
      const approved = await submit();
      await approveOnPage(approved.id);
      expect(await glob(approved.globId)).toMatchObject({ status: 'reviewing' });
      expect((await attributesOf(approved.globId)).outcome).toMatchObject({ kind: 'accept', by: ADMIN });

      const rejected = await submit({ statement: 'Another' });
      unwrap(await knowledge.reject(ADMIN, rejected.id, (await item(rejected.id)).version, 'No'));
      const g = await glob(rejected.globId);
      expect(g).toMatchObject({ status: 'signed_off' });
      expect(isArchivedDecision(g)).toBe(true);
      expect((await attributesOf(rejected.globId)).outcome).toMatchObject({ kind: 'reject', reason: 'No' });
    });

    it('archives the glob when the pipeline merges the item into another, and reopens it with the item', async () => {
      router.answer(toNewDoc('testing'));
      const first = await submit();
      expect(await queue.processNext()).toBe(first.id);
      const second = await submit({ statement: GEN_AGAIN, evidence: 'Tester note' });
      router.answer(
        toNewDoc('testing'),
        json({ checked: [{ ref: first.id, relation: 'same fact' }], duplicateOf: { id: first.id, quote: GEN, newQuote: GEN_AGAIN }, suppressedBy: null, coveredBy: null, contradicts: [] }),
      );
      expect(await queue.process(second.id)).toBe(true);
      expect(await item(second.id)).toMatchObject({ status: 'merged' });
      const closed = await glob(second.globId);
      expect(closed).toMatchObject({ status: 'signed_off' });
      expect(isArchivedDecision(closed)).toBe(true);
      expect((await attributesOf(second.globId)).outcome).toMatchObject({ kind: 'closed', by: 'slop' });
      expect(await glob(first.globId)).toMatchObject({ status: 'planning' });

      unwrap(await knowledge.reopen(ADMIN, second.id, (await item(second.id)).version));
      const back = await glob(second.globId);
      expect(back).toMatchObject({ status: 'planning', signedOffAt: null });
      expect(isArchivedDecision(back)).toBe(false);
      expect((await attributesOf(second.globId)).outcome).toBeNull();
    });

    it('refreshes the assessment with the draft’s diff when the pipeline drafts, and only then', async () => {
      const made = await submit();
      expect(await assessments(made.globId)).toHaveLength(1);
      unwrap(await knowledge.changeTarget(ADMIN, made.id, (await item(made.id)).version, { kind: 'doc', name: 'build_test_lint', section: 'Lint' }));
      expect(await assessments(made.globId)).toHaveLength(1);
      drafter.answer(draftAnswer('Lint', 'Run eslint --max-warnings 0.'));
      await queue.process(made.id);
      const versions = await assessments(made.globId);
      expect(versions).toHaveLength(2);
      expect(versions[1]?.content).toMatch(/Target: doc `build_test_lint`, section "Lint"/);
      expect(versions[1]?.content).toMatch(/Change: \+\d+ \/ -\d+ lines/);
      expect(versions[1]?.content).toMatch(/Accept: drafted, with no flags/);
      expect(notifier.hints).toContainEqual({ kind: 'glob.artifacts', boardId, globId: made.globId });
      // Assessing again with nothing new writes nothing.
      unwrap(await decisions.assess(ADMIN, made.globId));
      expect(await assessments(made.globId)).toHaveLength(2);
    });

    it('writes an assessment on demand for a decision that came from a person', async () => {
      const text = 'We agreed to push sync jobs over a websocket.';
      const added = unwrap(await inbox.add(DEV, boardId, { text, title: 'Standup' }));
      const promoted = unwrap(await inbox.promote(DEV, boardId, added.id));
      expect(await assessments(promoted.glob.id)).toEqual([]);
      const made = unwrap(await decisions.assess(DEV, promoted.glob.id));
      expect(made.content).toMatch(/Channel: inbox/);
      expect(made.content).toMatch(/has no knowledge item/);
      expect(errorCode(await decisions.assess(DEV, workId))).toBe('invalid_input');
      expect(errorCode(await decisions.assess('stranger@example.com', promoted.glob.id))).toBe('forbidden');
    });

    it('closes the learning\'s decision with the pipeline\'s write: Signed off, archived, closedAs and the closing link', async () => {
      const made = await submit();
      const other = await submit({ statement: 'Code in src/gen/ is generated' });
      await store.transaction(async (tx) => {
        const current = await kbItems(tx).getKbItem(made.id);
        if (current === null) throw new Error('missing');
        await kbItems(tx, TEST_KB_WRITES).updateKbItem({ ...current, status: 'merged', duplicateOf: other.id, version: current.version + 1 }, current.version);
      });
      expect(await glob(made.globId)).toMatchObject({ status: 'signed_off', links: [{ id: other.id, kind: 'duplicate_of', source: 'pipeline' }] });
      expect(await attributesOf(made.globId)).toMatchObject({ archived: true, closedAs: 'merged', outcome: { kind: 'closed', by: 'slop' } });
      expect(await item(made.id)).toMatchObject({ status: 'merged', duplicateOf: other.id });
    });
  });

  describe('scope and conflicts', () => {
    const contradict = async (id: string, other: string) =>
      store.transaction(async (tx) => {
        const current = await kbItems(tx).getKbItem(id);
        if (current === null) throw new Error('missing');
        await kbItems(tx, TEST_KB_WRITES).updateKbItem({ ...current, contradicts: [{ kind: 'item', ref: other, note: 'Says the opposite' }], version: current.version + 1 }, current.version);
      });

    it('flags only a contradiction with a broader decision', async () => {
      const broad = await submit({ type: 'decision', statement: 'Never edit generated files' });
      const narrow = await submit({ statement: 'Edit generated files only in src/gen/', type: 'pattern' });
      await approveOnPage(broad.id);

      await contradict(narrow.id, broad.id);
      expect((await attributesOf(narrow.globId)).conflictsWith).toEqual([broad.globId]);
      expect((await assessments(narrow.globId)).at(-1)?.content).toMatch(/Conflicts with s1k1 \(broader scope\)/);

      // The other way round: the broader item contradicting a narrower one is not flagged.
      const second = await submit({ type: 'decision', statement: 'Project-wide rule' });
      await contradict(second.id, narrow.id);
      expect((await attributesOf(second.globId)).conflictsWith).toBeUndefined();
      // Equal scope is not broader either.
      const peer = await submit({ type: 'decision', statement: 'A peer rule' });
      await contradict(peer.id, second.id);
      expect((await attributesOf(peer.globId)).conflictsWith).toBeUndefined();
    });

    it('re-checks narrower open decisions when a broader one is accepted', async () => {
      const broad = await submit({ type: 'pattern', statement: 'Narrow for now' });
      const narrow = await submit({ type: 'pattern', statement: 'Contradicts the broad one' });
      await contradict(narrow.id, broad.id);
      // Both are future-work decisions: equal scope, no flag.
      expect((await attributesOf(narrow.globId)).conflictsWith).toBeUndefined();
      await setScope(broad.globId, { kind: 'project', ref: null });
      await approveOnPage(broad.id);
      expect((await attributesOf(narrow.globId)).conflictsWith).toEqual([broad.globId]);
    });

    it('serves the accepted decisions that govern a glob, by scope kind, broadest first', async () => {
      const grouped = await newWork({ title: 'Billing work', group: 'billing' });
      const shared = async (statement: string, scope: unknown) => {
        const made = await submit({ statement, type: 'decision' });
        await setScope(made.globId, scope);
        await approveOnPage(made.id);
        return made.globId;
      };
      const forGlob = await shared('Only for the existing work', { kind: 'glob', ref: workId });
      const forGroup = await shared('Billing rule', { kind: 'area_group', ref: 'billing' });
      const forProject = await shared('Project rule', { kind: 'project', ref: null });
      advance(60_000);
      const later = await newWork({ title: 'Later billing work', group: 'billing' });
      const laterOther = await newWork({ title: 'Later other work', group: 'ops' });
      const forFuture = await shared('Future billing work', { kind: 'future_work', ref: 'billing' });
      const forFutureAll = await shared('Future work', { kind: 'future_work', ref: null });
      // An open decision binds nothing.
      await submit({ statement: 'Not accepted yet', type: 'decision' });

      const ids = async (id: string) => unwrap(await artifacts.context(DEV, id)).scopedDecisions.map((d) => d.id);
      expect(await ids(workId)).toEqual([forProject, forGlob]);
      expect(await ids(grouped.id)).toEqual([forProject, forGroup]);
      expect(await ids(later.id)).toEqual([forProject, forGroup, forFuture, forFutureAll]);
      expect(await ids(laterOther.id)).toEqual([forProject, forFutureAll]);
      expect(await ids(forGlob)).toEqual([]);
      const context = unwrap(await artifacts.context(DEV, later.id));
      expect(context.scopedDecisions[0]).toMatchObject({ id: forProject, scope: { kind: 'project', ref: null }, statement: 'Project rule', outcome: 'accept' });
      expect(context.authority).toMatch(/scopedDecisions/);
    });

    it('attaches the decisions that govern a new glob, and nothing when none do', async () => {
      const before = await newWork({ title: 'Before any decision' });
      expect(await artifactsOf(before.id, 'attachment')).toEqual([]);
      const made = await submit({ type: 'decision', statement: 'Project rule' });
      await approveOnPage(made.id);
      const after = await newWork({ title: 'After the decision' });
      const [attachment] = await artifactsOf(after.id, 'attachment');
      expect(attachment).toMatchObject({ label: 'Decisions' });
      expect(attachment?.content).toContain(`${made.globId} (the whole project): Project rule`);
      expect((await artifactsOf(before.id, 'attachment'))).toEqual([]);
    });

    it('gives the parts of a split the decisions that govern them, not only a created glob', async () => {
      const made = await submit({ type: 'decision', statement: 'Project rule' });
      await approveOnPage(made.id);
      const original = await newWork({ title: 'Big', plan: 'Everything' });
      const part = (title: string) => ({ title, summary: '', plan: `Do ${title}` });
      const parts = unwrap(await globs.split(ADMIN, original.id, original.version, { idempotencyKey: null, parts: [part('One'), part('Two')] }));
      const second = parts[1];
      if (second === undefined) throw new Error('expected two parts');
      const [attachment] = await artifactsOf(second.id, 'attachment');
      expect(attachment).toMatchObject({ label: 'Decisions' });
      expect(attachment?.content).toContain(`${made.globId} (the whole project): Project rule`);
    });

    it('lets only admins and POs change a scope, and refuses other attributes', async () => {
      const made = await submit();
      const seen = await glob(made.globId);
      expect(errorCode(await globs.update(DEV, made.globId, seen.version, { attributes: { scope: { kind: 'project', ref: null } } }))).toBe('forbidden');
      expect(errorCode(await globs.update(PO, made.globId, seen.version, { attributes: { scope: { kind: 'project', ref: null }, archived: true } }))).toBe('invalid_input');
      const changed = unwrap(await globs.update(PO, made.globId, seen.version, { attributes: { scope: { kind: 'glob', ref: workId } } }));
      expect(changed.attributes).toMatchObject({ scope: { kind: 'glob', ref: workId } });
    });
  });

  describe('context', () => {
    it('keeps a work glob’s context and adds the payload (the same as plan), attributes only on decisions', async () => {
      const work = await newWork({ title: 'With a plan', plan: '# The plan' });
      const context = unwrap(await artifacts.context(DEV, work.id));
      expect(context.plan).toEqual({ version: 1, content: '# The plan' });
      expect(context.payload).toEqual(context.plan);
      expect(context.scopedDecisions).toEqual([]);
      expect(context).not.toHaveProperty('attributes');
      expect(Object.keys(context)).toEqual(expect.arrayContaining(['glob', 'board', 'plan', 'implementationRecord', 'attachments', 'available', 'decisions', 'inbox', 'authority', 'fetch']));
      const plan = unwrap(await artifacts.plan(DEV, work.id, null));
      expect(plan.kind).toBe('plan');
      expect(plan.current?.content).toBe('# The plan');
    });

    it('serves a decision’s proposal as its plan and payload, its attributes, and lists the assessment as available', async () => {
      const made = await submit({ type: 'decision' });
      const context = unwrap(await artifacts.context(DEV, made.globId));
      expect(context.payload).toEqual(context.plan);
      expect(context.payload?.content).toContain(GEN);
      expect(context.attributes).toMatchObject({ channel: 'agent', origin: { kind: 'submitted' } });
      expect(context.available.map((a) => a.kind)).toEqual(['assessment']);
      expect(context.scopedDecisions).toEqual([]);
      const read = unwrap(await artifacts.artifact(DEV, made.globId, 'assessment', ''));
      expect(read.content).toMatch(/## Assessment/);
      const plan = unwrap(await artifacts.plan(DEV, made.globId, null));
      expect(plan.current?.content).toContain(GEN);
      expect(isDecisionAttributes(context.attributes)).toBe(true);
    });
  });

  describe('the work commands', () => {
    it('refuses every work command on a decision, and decision commands on work, but picks up and edits both', async () => {
      const made = await submit();
      const id = made.globId;
      const v = async () => (await glob(id)).version;
      const refused = [
        await globs.start(ADMIN, id, await v()),
        await globs.startAnyway(ADMIN, id, await v()),
        await globs.retrigger(ADMIN, id, await v()),
        await globs.startAgain(ADMIN, id, await v()),
        await globs.merge(ADMIN, id, await v()),
        await globs.retryMerge(ADMIN, id, await v()),
        await globs.resolveConflict(ADMIN, id, await v()),
        await globs.reviewLabel(ADMIN, id, await v(), 'QA', { kind: 'approve' }),
        await globs.requestReadyFromBoard(ADMIN, id, await v()),
        await globs.escalateToSame(ADMIN, id, { reason: 'x' }),
        await globs.applyEvent(id, (g, ctx) => machine.merged(g, { sha: 'abc1234' }, ctx)),
      ];
      expect(refused.map(errorCode)).toEqual(refused.map(() => 'invalid_transition'));
      expect(errorCode(await globs.signOffDecision(ADMIN, workId, (await glob(workId)).version))).toBe('invalid_transition');
      expect(errorCode(await globs.reopenDecision(ADMIN, workId, (await glob(workId)).version))).toBe('invalid_transition');
      expect(await glob(id)).toMatchObject({ status: 'planning', version: 1 });
      expect(unwrap(await globs.pickUp(ADMIN, id, 1, false))).toMatchObject({ status: 'in_progress' });
      expect(errorCode(await globs.pickUp(DEV, id, 2, false))).toBe('forbidden');
      expect(unwrap(await globs.update(ADMIN, id, 2, { title: 'Renamed' })).title).toBe('Renamed');
      expect(errorCode(await globs.update(ADMIN, id, 3, { type: 'sub' }))).toBe('invalid_combination');
      expect(errorCode(await globs.update(ADMIN, id, 3, { category: 'task' }))).toBe('invalid_combination');
    });

    it('shows a decision glob’s allowed actions and artifacts in its view', async () => {
      const made = await submit();
      const view = unwrap(await globs.get(ADMIN, made.globId));
      expect(view.allowedActions).toEqual(['pick_up', 'delete']);
      expect(view.artifacts.map((a) => a.kind)).toEqual(['plan', 'assessment']);
      expect(unwrap(await globs.get(DEV, made.globId)).allowedActions).toEqual([]);
    });

    it('never deletes a learning an agent submitted or slop mined (reject it instead); admins and POs delete a person\'s decision', async () => {
      const made = await submit();
      const version = (await glob(made.globId)).version;
      expect(errorCode(await globs.delete(DEV, made.globId, version))).toBe('forbidden');
      expect(errorCode(await globs.delete(ADMIN, made.globId, version))).toBe('invalid_input');
      // Rejected, it is still kept: a rejected learning suppresses its repeats.
      await inDoing(made);
      unwrap(await decide(made.globId, { outcome: 'reject', reason: 'No' }));
      expect(errorCode(await globs.delete(PO, made.globId, (await glob(made.globId)).version))).toBe('invalid_input');
      expect(await item(made.id)).toMatchObject({ status: 'rejected' });
      // A decision a person made is theirs to delete.
      const manual = await store.transaction((tx) =>
        createDecisionInTx(tx, { clock }, {
          boardId,
          actor: { email: ADMIN, role: 'admin' },
          title: 'A person\'s decision',
          summary: 'x',
          payload: 'x',
          attributes: { scope: { kind: 'project', ref: null }, origin: { kind: 'manual' }, channel: 'human', outcome: null },
          creationKey: 'manual:delete',
        }),
      );
      const manualId = manual.ok ? manual.value.glob.id : '';
      unwrap(await globs.delete(PO, manualId, (await glob(manualId)).version));
      expect(await store.transaction((tx) => tx.getGlob(manualId))).toBeNull();
    });

    it('does not create the needs-work glob when the decision would be refused', async () => {
      const made = await submit();
      await inDoing(made);
      const before = (await store.transaction((tx) => tx.listGlobs(boardId, {}))).length;
      // A dev may not decide.
      expect(errorCode(await decide(made.globId, { outcome: 'needs_work', reason: 'x' }, DEV))).toBe('forbidden');
      expect(errorCode(await decisions.decide(ADMIN, made.globId, 999, { outcome: 'needs_work', reason: 'x' }))).toBe('version_conflict');
      expect((await store.transaction((tx) => tx.listGlobs(boardId, {}))).length).toBe(before);
    });
  });

  describe('the inbox', () => {
    const text = 'Standup 3 Oct.\n\nWe agreed the sync jobs will be pushed over a websocket instead of polling.';

    it('numbers a promoted decision after the existing KB items of the board, in the same k sequence', async () => {
      const first = await submit();
      const second = await submit({ statement: 'Another' });
      expect([first.id, second.id]).toEqual(['s1k1', 's1k2']);
      const added = unwrap(await inbox.add(DEV, boardId, { text, title: 'Sync standup' }));
      expect(unwrap(await inbox.promote(DEV, boardId, added.id, {})).glob.id).toBe('s1k3');
      expect((await submit({ statement: 'A third' })).globId).toBe('s1k4');
    });

    it('promotes an item to a decision glob in Planning and attaches the item to it as its source', async () => {
      const added = unwrap(await inbox.add(DEV, boardId, { text, title: 'Sync standup' }));
      const result = unwrap(await inbox.promote(DEV, boardId, added.id, { statement: 'Sync jobs use a websocket' }));
      const g = result.glob;
      expect(g).toMatchObject({ id: 's1k1', category: 'decision', status: 'planning', title: 'Sync standup', summary: 'Sync jobs use a websocket' });
      expect(g.attributes).toEqual({ scope: { kind: 'future_work', ref: null }, origin: { kind: 'inbox', id: added.id }, channel: 'inbox', outcome: null });
      const [plan] = await artifactsOf(g.id, 'plan');
      expect(plan?.content).toContain('Sync jobs use a websocket');
      expect(plan?.content).toContain('> Standup 3 Oct.');
      expect(plan?.provenance.by).toBe('human');
      const [attachment] = await artifactsOf(g.id, 'attachment');
      expect(attachment).toMatchObject({ label: 'From the inbox: Sync standup' });
      expect(result.view).toMatchObject({ status: 'attached', attachedTo: [{ globId: g.id, title: 'Sync standup' }] });
      expect(unwrap(await inbox.list(DEV, boardId)).at(0)?.attachedTo.map((a) => a.globId)).toEqual([g.id]);
      expect(notifier.hints).toContainEqual({ kind: 'board.inbox', boardId });
    });

    it('is idempotent, refuses a discarded item and an invalid scope, and checks membership', async () => {
      const added = unwrap(await inbox.add(DEV, boardId, { text, title: 'Sync standup' }));
      const first = unwrap(await inbox.promote(DEV, boardId, added.id));
      const second = unwrap(await inbox.promote(DEV, boardId, added.id));
      expect(second.glob.id).toBe(first.glob.id);
      expect(await artifactsOf(first.glob.id, 'attachment')).toHaveLength(1);
      expect(errorCode(await inbox.promote(DEV, boardId, added.id, { scope: { kind: 'galaxy' } }))).toBe('invalid_input');
      expect(errorCode(await inbox.promote('stranger@example.com', boardId, added.id))).toBe('forbidden');
      expect(errorCode(await inbox.promote(DEV, boardId, 999))).toBe('not_found');
      const other = unwrap(await inbox.add(DEV, boardId, { text: 'Something else entirely', title: 'Other' }));
      unwrap(await inbox.discard(DEV, boardId, other.id));
      expect(errorCode(await inbox.promote(DEV, boardId, other.id))).toBe('invalid_input');
    });

    it('records the outcome only when a promoted decision is accepted: nothing to edit or retarget', async () => {
      const added = unwrap(await inbox.add(DEV, boardId, { text, title: 'Sync standup' }));
      const { glob: promoted } = unwrap(await inbox.promote(DEV, boardId, added.id, { scope: { kind: 'project', ref: null } }));
      await pickUp(promoted.id, PO);
      expect(errorCode(await decide(promoted.id, { outcome: 'accept_with_edits', editedDraft: 'x' }, PO))).toBe('invalid_input');
      expect(errorCode(await decide(promoted.id, { outcome: 'retarget', target: { kind: 'doc', name: 'build_test_lint', section: null } }, PO))).toBe('invalid_input');
      expect(unwrap(await decide(promoted.id, { outcome: 'accept' }, PO))).toMatchObject({ status: 'reviewing' });
      expect(unwrap(await globs.signOffDecision(PO, promoted.id, (await glob(promoted.id)).version)).status).toBe('signed_off');
      const governed = unwrap(await artifacts.context(DEV, workId));
      expect(governed.scopedDecisions.map((d) => d.id)).toEqual([promoted.id]);
    });

    it('promotes an extracted decision, once, numbered after the KB items', async () => {
      await submit();
      const row = await store.transaction((tx) =>
        tx.upsertDecision({
          boardId,
          itemId: 1,
          globId: workId,
          group: null,
          statement: 'Use the websocket',
          quote: 'We agreed to use the websocket',
          decidedBy: DEV,
          decidedAt: START,
          sourceKind: 'inbox',
          sourceRef: 'inbox:1',
          sourceLabel: 'Sync standup',
          sourceUrl: null,
          createdAt: START,
        }),
      );
      const g = unwrap(await decisions.promoteExtracted(DEV, boardId, row.id));
      expect(g.id).toBe('s1k2');
      expect(g.attributes).toMatchObject({ scope: { kind: 'glob', ref: workId }, origin: { kind: 'extracted', decisionId: row.id }, channel: 'human' });
      expect(unwrap(await decisions.promoteExtracted(DEV, boardId, row.id)).id).toBe(g.id);
      expect(errorCode(await decisions.promoteExtracted(DEV, boardId, 999))).toBe('not_found');
    });
  });
});
