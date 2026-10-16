import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { LlmUnavailable } from '../src/app/intake-service.js';
import type { Llm, LlmRequest } from '../src/app/intake-service.js';
import { RolloutService } from '../src/app/rollout-service.js';
import type { Result } from '../src/domain/errors.js';
import { DEFAULT_ROLLOUT_PATHS } from '../src/domain/merge-policy.js';
import { ROLLOUT_NOT_WRITTEN_TITLE } from '../src/domain/rollout.js';
import type { DiffSummary } from '../src/domain/sub-gate.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const ADMIN = 'admin@example.com';

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

describe('RolloutService', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let llm: FakeLlm;
  let service: RolloutService;
  let diff: DiffSummary | null;
  let boardId: number;

  const merged = async (): Promise<Glob> => {
    const created = unwrap(
      await globs.create(ADMIN, { boardId, title: 'Infra change', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    );
    return store.transaction(async (tx) => {
      const next = { ...created, status: 'reviewing' as const, labels: { CR: 'required' as const }, pr: { number: 1, state: 'merged' as const, headSha: 'abc1234' }, version: created.version + 1 };
      await tx.updateGlob(next, created.version);
      return next;
    });
  };
  const stepsOf = (id: string) => [...store.state.humanSteps.values()].filter((s) => s.globId === id);

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    const clock = { now: () => '2026-10-13T12:00:00.000Z' };
    let runs = 0;
    globs = new GlobService({ store, notifier, clock, ids: { runId: () => `run-${++runs}` }, routines: { hasRoutine: () => Promise.resolve(true) } });
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: 'Admin', active: true }));
    boardId = unwrap(await new BoardService({ store, notifier }).create(ADMIN, { name: 'demo', repo: null, timeZone: 'UTC', environments: [] })).id;
    llm = new FakeLlm();
    diff = { changedLines: 10, files: ['apps/server/src/config.ts', 'apps/web/src/a.ts'], patches: { 'apps/server/src/config.ts': '+  SLOP_X: z.string().default("a"),' } };
    service = new RolloutService({
      store,
      clock,
      globs,
      changes: { mergedDiff: () => Promise.resolve(diff) },
      llm,
      model: 'fake-model',
      rolloutPathsOf: () => Promise.resolve(DEFAULT_ROLLOUT_PATHS),
    });
  });

  it('gives the model the rollout-path diff and the record, and records "No rollout needed" with the reason when it says none', async () => {
    const g = await merged();
    llm.next = JSON.stringify({ decision: 'none', reason: 'SLOP_X has a default; nothing to set' });
    expect(await service.run(g.id, 'm1')).toBe('done');
    expect(llm.requests[0]?.prompt).toContain('SLOP_X: z.string()');
    expect(llm.requests[0]?.spend).toEqual({ boardId, source: 'rollout', globId: g.id });
    expect(stepsOf(g.id)).toEqual([]);
    expect(await globs.rolloutUnwritten(g.id)).toBe(false);
  });

  it('writes the steps when it says steps', async () => {
    const g = await merged();
    llm.next = JSON.stringify({ decision: 'steps', rollout: '- setting: Add SLOP_X to /slop/prod/server-env' });
    await service.run(g.id, 'm1');
    expect(stepsOf(g.id).map((s) => [s.title, s.state])).toEqual([['Add SLOP_X to /slop/prod/server-env', 'open']]);
  });

  it('adds only a specific question when it cannot decide', async () => {
    const g = await merged();
    llm.next = JSON.stringify({ decision: 'ask', question: 'Does SLOP_X need setting in prod? It has no default' });
    await service.run(g.id, 'm1');
    expect(stepsOf(g.id).map((s) => s.title)).toEqual(['Does SLOP_X need setting in prod? It has no default']);
  });

  it('drops the job once the rollout is written, so a repeat asks the model nothing', async () => {
    const g = await merged();
    llm.next = JSON.stringify({ decision: 'none', reason: 'nothing' });
    await service.run(g.id, 'm1');
    expect(await service.run(g.id, 'm1')).toBe('dropped');
    expect(llm.requests).toHaveLength(1);
  });

  it('waits without spending an attempt while the model is unavailable, and throws on an unusable answer', async () => {
    const g = await merged();
    llm.next = new LlmUnavailable('AWS sign-in expired', 'Sign in again');
    expect(await service.run(g.id, 'm1')).toMatchObject({ state: 'pending' });
    llm.next = 'I think nothing is needed';
    await expect(service.run(g.id, 'm1')).rejects.toThrow('Unusable rollout answer');
    expect(stepsOf(g.id)).toEqual([]);
  });

  it('reads nothing when the diff cannot be read', async () => {
    const g = await merged();
    diff = null;
    expect(await service.run(g.id, 'm1')).toBe('done');
    expect(llm.requests).toEqual([]);
  });

  it('backfill: replaces "Rollout steps not written" on globs whose merge no longer touches a rollout path without asking the model', async () => {
    const g = await merged();
    await store.transaction(async (tx) => {
      await tx.appendEvents([{ type: 'Merged', globId: g.id, actor: null, at: '2026-10-13T11:00:00.000Z', data: { sha: 'm1' } }]);
      await tx.saveHumanSteps([
        {
          id: 'hs_1',
          boardId,
          globId: g.id,
          kind: 'rollout',
          title: ROLLOUT_NOT_WRITTEN_TITLE,
          detail: null,
          who: 'anyone',
          due: 'after_merge',
          state: 'open',
          blocks: ['sign_off', 'dependants'],
          check: null,
          script: null,
          why: null,
          permissions: null,
          commands: [],
          verify: null,
          origin: 'rollout-paths',
          createdBy: 'slop',
          createdAt: '2026-10-13T11:00:00.000Z',
          doneBy: null,
          doneAt: null,
          dismissedReason: null,
          dueSince: null,
        },
      ]);
    });
    expect(await service.backfill(boardId)).toBe(1);
    diff = { changedLines: 5, files: ['apps/server/drizzle/0071_x.sql'] };
    expect(await service.run(g.id, 'm1')).toBe('done');
    expect(llm.requests).toEqual([]);
    expect(stepsOf(g.id).map((s) => s.state)).toEqual(['dismissed']);
    expect(await service.backfill(boardId)).toBe(0);
  });
});
