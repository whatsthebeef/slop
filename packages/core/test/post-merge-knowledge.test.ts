import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import * as machine from '../src/domain/machine.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { PostMergeKnowledgeService } from '../src/app/post-merge-knowledge-service.js';
import type { Result } from '../src/domain/errors.js';
import { laneOf } from '../src/domain/events.js';
import { decisionOf } from '../src/domain/decision-glob.js';
import { checkMergePolicy } from '../src/domain/merge-policy.js';
import {
  checkPostMergeAnswer,
  driftTitle,
  isDocsOnly,
  postMergeSkip,
  postMergeSummary,
} from '../src/domain/post-merge-knowledge.js';
import type { DiffSummary } from '../src/domain/sub-gate.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const ADMIN = 'admin@example.com';
const SPEC = 'docs/spec.md';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

class FakeLlm implements Llm {
  requests: LlmRequest[] = [];
  next: string | Error = '';
  complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    return this.next instanceof Error ? Promise.reject(this.next) : Promise.resolve(this.next);
  }
}

const FACT = {
  statement: 'The post_merge_knowledge effect runs on the llm lane after every final merge.',
  evidence: 'packages/core/src/domain/machine.ts',
  target: 'architecture',
};
const DRIFT = {
  sections: [{ path: SPEC, section: 'Outbox' }],
  change: 'A final merge now queues post_merge_knowledge.',
};

describe('post-merge knowledge (domain)', () => {
  it('skips human, agent-set, docs-only and file-less merges', () => {
    const work = { title: 'Do it', implementer: null, category: 'task', type: 'same' } as const;
    expect(postMergeSkip(work, ['a.ts'])).toBeNull();
    expect(postMergeSkip({ ...work, category: 'action' }, ['a.ts'])).toBe('human glob');
    expect(postMergeSkip(work, [])).toBe('no files');
    expect(postMergeSkip(work, ['README.md', 'docs/a.png'])).toBe('docs only');
    expect(isDocsOnly(['README.md', 'a.ts'])).toBe(false);
  });

  it('keeps at most five facts, drops malformed ones, and believes a drift only for the given spec files', () => {
    const facts = Array.from({ length: 8 }, (_, i) => ({
      ...FACT,
      statement: `fact ${String(i)}`,
    }));
    const checked = checkPostMergeAnswer(
      {
        facts: [
          ...facts,
          { statement: '', evidence: 'x', target: 'architecture' },
          { ...FACT, target: 'other' },
        ],
        drift: DRIFT,
      },
      [SPEC],
    );
    expect(checked?.facts).toHaveLength(5);
    expect(checked?.drift?.sections).toEqual([{ path: SPEC, section: 'Outbox' }]);
    expect(
      checkPostMergeAnswer(
        { facts: [], drift: { ...DRIFT, sections: [{ path: 'other.md', section: 'x' }] } },
        [SPEC],
      )?.drift,
    ).toBeNull();
    expect(checkPostMergeAnswer({ nope: true }, [SPEC])).toBeNull();
  });

  it('words the summary and the drift title', () => {
    expect(postMergeSummary({ facts: 2, drift: null })).toBe(
      'post-merge: 2 facts submitted, spec drift: none',
    );
    expect(postMergeSummary({ facts: 1, drift: 's1t9' })).toBe(
      'post-merge: 1 fact submitted, spec drift: s1t9',
    );
    expect(postMergeSummary({ facts: 0, drift: null, specConfigured: false })).toContain(
      'not checked',
    );
    expect(postMergeSummary({ facts: 0, drift: null, skipped: 'docs only' })).toBe(
      'post-merge: skipped (docs only)',
    );
    expect(
      driftTitle('s1t2', [
        { path: SPEC, section: 'Outbox' },
        { path: SPEC, section: 'Lanes' },
      ]),
    ).toBe('Update spec/guide for s1t2: Outbox, Lanes');
  });

  it('puts the pass on the llm lane', () => {
    expect(laneOf('post_merge_knowledge')).toBe('llm');
  });

  it('accepts specPaths in the merge policy', () => {
    expect(checkMergePolicy({ specPaths: [SPEC, 'docs/guide.md'] }).ok).toBe(true);
    expect(checkMergePolicy({ specPaths: ['/abs'] }).ok).toBe(false);
  });
});

describe('PostMergeKnowledgeService', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let llm: FakeLlm;
  let service: PostMergeKnowledgeService;
  let diff: DiffSummary | null;
  let boardId: number;
  let specText: string;

  const merged = async (title = 'Add the pass', over: Partial<Glob> = {}): Promise<Glob> => {
    const created = unwrap(
      await globs.create(ADMIN, {
        boardId,
        title,
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    return store.transaction(async (tx) => {
      const next = {
        ...created,
        ...over,
        status: 'reviewing' as const,
        labels: { CR: 'required' as const },
        pr: { number: 7, state: 'merged' as const, headSha: 'abc1234' },
        version: created.version + 1,
      };
      await tx.updateGlob(next, created.version);
      return next;
    });
  };
  const learnings = () =>
    [...store.state.globs.values()].map((e) => e.glob).filter((g) => g.category === 'decision');
  const subs = () =>
    [...store.state.globs.values()]
      .map((e) => e.glob)
      .filter((g) => g.title.startsWith('Update spec/guide for'));
  const summaryOf = (id: string) =>
    [...store.state.events]
      .filter((e) => e.globId === id && e.type === 'PostMergeKnowledge')
      .map((e) => e.data['summary']);
  const setSpecPaths = (paths: string[]) =>
    store.transaction((tx) =>
      tx.saveKnowledge({
        boardId,
        kind: 'merge_policy',
        name: 'merge-policy',
        area: null,
        audience: [],
        description: '',
        content: JSON.stringify({ specPaths: paths }),
        layer: 'file',
        version: 1,
        source: 'edit',
        updatedBy: ADMIN,
        updatedAt: '2026-10-17T12:00:00.000Z',
      }),
    );

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => '2026-10-17T12:00:00.000Z' };
    let runs = 0;
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => `run-${++runs}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: 'Admin', active: true }));
    boardId = unwrap(
      await new BoardService({ store, notifier }).create(ADMIN, {
        name: 'demo',
        repo: 'o/r',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    llm = new FakeLlm();
    diff = {
      changedLines: 30,
      files: ['packages/core/src/domain/machine.ts', 'apps/server/src/main.ts'],
      patches: {
        'packages/core/src/domain/machine.ts': '+ .effect({ kind: "post_merge_knowledge" })',
      },
    };
    specText = '# Spec\n## Outbox\nA final merge queues release_waiting.';
    service = new PostMergeKnowledgeService({
      store,
      clock,
      changes: { mergedDiff: () => Promise.resolve(diff) },
      specs: {
        read: (_b, _sha, paths) =>
          Promise.resolve(paths.includes(SPEC) ? [{ path: SPEC, text: specText }] : []),
      },
      globs,
      llm,
    });
  });

  it('is queued by a final merge, for every glob, with the merge commit', async () => {
    const created = unwrap(
      await globs.create(ADMIN, {
        boardId,
        title: 'Hand built',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    await store.transaction(async (tx) => {
      await tx.updateGlob(
        {
          ...created,
          status: 'merging',
          pr: { number: 7, state: 'ready', headSha: 'abc1234' },
          version: created.version + 1,
        },
        created.version,
      );
    });
    unwrap(await globs.applyEvent(created.id, (g, c) => machine.merged(g, { sha: 'sha1' }, c)));
    const job = store.state.outbox.find((e) => e.kind === 'post_merge_knowledge');
    expect(job).toMatchObject({ kind: 'post_merge_knowledge', globId: created.id });
    expect(JSON.stringify(job)).toContain('sha1');
  });

  it('submits each fact as a slop-raised fact learning sourced on the glob and records the summary', async () => {
    const g = await merged();
    llm.next = JSON.stringify({
      facts: [FACT, { ...FACT, statement: 'Operations: nothing else.', target: 'operations' }],
      drift: null,
    });
    expect(await service.run(g.id, 'm1')).toBe('done');
    expect(llm.requests[0]?.spend).toEqual({
      boardId,
      source: 'post_merge_knowledge',
      globId: g.id,
    });
    expect(llm.requests[0]?.prompt).toContain('post_merge_knowledge');
    const made = learnings();
    expect(made).toHaveLength(2);
    const attrs = made.map((l) => decisionOf(l));
    expect(
      attrs.every(
        (a) => a?.origin.kind === 'mined' && a.kind === 'fact' && a.sourceGlobs?.includes(g.id),
      ),
    ).toBe(true);
    expect(attrs.map((a) => a?.target?.suggested).sort()).toEqual(['architecture', 'operations']);
    expect(summaryOf(g.id)).toEqual([
      'post-merge: 2 facts submitted, spec drift: not checked (no spec paths)',
    ]);
    expect(subs()).toEqual([]);
  });

  it('runs once per glob', async () => {
    const g = await merged();
    llm.next = JSON.stringify({ facts: [FACT], drift: null });
    await service.run(g.id, 'm1');
    await service.run(g.id, 'm1');
    expect(llm.requests).toHaveLength(1);
    expect(learnings()).toHaveLength(1);
  });

  it('files one drift sub naming the sections when behaviour changed and the spec was not updated', async () => {
    await setSpecPaths([SPEC]);
    const g = await merged();
    llm.next = JSON.stringify({ facts: [], drift: DRIFT });
    await service.run(g.id, 'm1');
    expect(llm.requests[0]?.prompt).toContain('A final merge queues release_waiting.');
    const [sub] = subs();
    expect(subs()).toHaveLength(1);
    expect(sub?.title).toBe(`Update spec/guide for ${g.id}: Outbox`);
    const plan = store.state.artifacts.find((a) => a.globId === sub?.id && a.kind === 'plan');
    expect(plan?.content).toContain('A final merge now queues post_merge_knowledge.');
    expect(plan?.content).toContain('PR #7');
    expect(plan?.content).toContain(SPEC);
    expect(summaryOf(g.id)).toEqual([
      `post-merge: 0 facts submitted, spec drift: ${sub?.id ?? ''}`,
    ]);
  });

  it('files no sub when the model reports no drift (the PR updated the spec) and tells it which spec files the diff changed', async () => {
    await setSpecPaths([SPEC]);
    diff = { changedLines: 5, files: ['apps/server/src/main.ts', SPEC], patches: {} };
    const g = await merged();
    llm.next = JSON.stringify({ facts: [], drift: null });
    await service.run(g.id, 'm1');
    expect(llm.requests[0]?.prompt).toContain(`this change already updated: ${SPEC}`);
    expect(subs()).toEqual([]);
    expect(summaryOf(g.id)).toEqual(['post-merge: 0 facts submitted, spec drift: none']);
  });

  it('ignores a drift on a board with no spec paths', async () => {
    const g = await merged();
    llm.next = JSON.stringify({ facts: [], drift: DRIFT });
    await service.run(g.id, 'm1');
    expect(subs()).toEqual([]);
  });

  it('skips docs-only merges without a model call', async () => {
    diff = { changedLines: 5, files: ['docs/guide.md', 'README.md'] };
    const g = await merged();
    expect(await service.run(g.id, 'm1')).toBe('done');
    expect(llm.requests).toEqual([]);
    expect(summaryOf(g.id)).toEqual(['post-merge: skipped (docs only)']);
  });

  it('skips the agent-set glob', async () => {
    const g = await merged('Agent set v7', { implementer: 'slop' });
    expect(await service.run(g.id, 'm1')).toBe('done');
    expect(llm.requests).toEqual([]);
    expect(summaryOf(g.id)).toEqual(['post-merge: skipped (agent set)']);
  });

  it('drops a glob that has not merged, and does nothing when the diff cannot be read', async () => {
    const created = unwrap(
      await globs.create(ADMIN, {
        boardId,
        title: 'Open',
        type: 'same',
        category: 'task',
        group: null,
        environment: null,
        autoTrigger: false,
        idempotencyKey: null,
      }),
    );
    expect(await service.run(created.id, 'm1')).toBe('dropped');
    diff = null;
    const g = await merged();
    expect(await service.run(g.id, 'm1')).toBe('done');
    expect(llm.requests).toEqual([]);
    expect(summaryOf(g.id)).toEqual([]);
  });

  it('throws on an unusable answer and on a missing model, so the outbox retries', async () => {
    const g = await merged();
    llm.next = 'not json';
    await expect(service.run(g.id, 'm1')).rejects.toThrow('no usable answer');
    llm.next = new LlmUnavailable('credentials expired', 'log in');
    await expect(service.run(g.id, 'm1')).rejects.toBeInstanceOf(LlmUnavailable);
    expect(learnings()).toEqual([]);
    expect(summaryOf(g.id)).toEqual([]);
  });
});
