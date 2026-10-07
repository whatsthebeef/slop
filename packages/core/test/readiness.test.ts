import { describe, expect, it } from 'vitest';
import { readiness, recentRoutineFailures, routineFailureFix, stuckHint, unreactedCheckFailures } from '../src/domain/readiness.js';
import type { ReadinessFacts } from '../src/domain/readiness.js';
import { NOW, board, glob } from './fixtures.js';

const ready: ReadinessFacts = {
  board: {
    ...board,
    environments: [
      { name: 'dev', allowBranchDeploy: true, subDefault: true },
      { name: 'prod', allowBranchDeploy: false },
    ],
    agentSetVersion: 3,
  },
  repoConnected: true,
  installUrl: null,
  subGateWorkflow: true,
  committedAgentSetVersion: 3,
  hasBuildDoc: true,
  ticks: { routines: true, routine_repo: true, claude_app: true },
  recentFailures: [],
  unreactedCheckFailures: [],
};

const stateOf = (facts: ReadinessFacts) => Object.fromEntries(readiness(facts).map((i) => [i.key, i.state]));

describe('board readiness', () => {
  it('is all ok for a board with everything set up', () => {
    expect(Object.values(stateOf(ready)).every((s) => s === 'ok')).toBe(true);
  });

  it('says what is missing, with a fix', () => {
    const items = readiness({
      ...ready,
      repoConnected: false,
      installUrl: 'https://github.com/apps/slop/installations/new?state=1',
      subGateWorkflow: false,
      committedAgentSetVersion: 2,
      hasBuildDoc: false,
      board: { ...ready.board, environments: [{ name: 'dev', allowBranchDeploy: true }] },
      ticks: {},
    });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.repo_app).toMatchObject({ state: 'missing', fix: { kind: 'link', href: 'https://github.com/apps/slop/installations/new?state=1' } });
    expect(byKey.sub_gate?.fix).toMatchObject({ kind: 'link', href: 'https://github.com/acme/app/new/main?filename=.github/workflows/sub-gate.yml' });
    expect(byKey.agent_set?.detail).toMatch(/version 2; the board's is 3/);
    expect(byKey.build_doc).toMatchObject({ state: 'missing', fix: { kind: 'knowledge' } });
    expect(byKey.environments?.detail).toMatch(/default for subs/);
    expect(items.filter((i) => i.manual).map((i) => i.state)).toEqual(['missing', 'missing', 'missing']);
  });

  it('marks unknown what slop cannot check yet', () => {
    const states = stateOf({ ...ready, repoConnected: null, subGateWorkflow: null, committedAgentSetVersion: 'unknown' });
    expect(states.repo_app).toBe('unknown');
    expect(states.sub_gate).toBe('unknown');
    expect(states.agent_set).toBe('unknown');
  });

  it('says an invalid agent-set file needs re-running slop init', () => {
    const item = readiness({ ...ready, committedAgentSetVersion: 'unreadable' }).find((i) => i.key === 'agent_set');
    expect(item).toMatchObject({ state: 'missing' });
    expect(item?.detail).toMatch(/isn't valid: run slop init 1/);
  });

  it('turns a ticked item red when a recent routine failure points to it', () => {
    const items = readiness({
      ...ready,
      recentFailures: [{ globId: 's1t9', reason: 'remote: Repository not found.' }],
    });
    const repo = items.find((i) => i.key === 'routine_repo');
    expect(repo).toMatchObject({ state: 'failing' });
    expect(repo?.detail).toMatch(/s1t9 failed.*Add the repo to the routine's repositories/);
  });

  it("maps routine failures to their fix", () => {
    expect(routineFailureFix('HttpError: Resource not accessible by integration')?.key).toBe('claude_app');
    expect(routineFailureFix('fatal: could not read from remote repository')?.key).toBe('routine_repo');
    expect(routineFailureFix('Routine fire failed: 401')?.key).toBe('routines');
    expect(routineFailureFix('Tests failed')).toBeNull();
  });

  it('keeps recent failures only, newest first', () => {
    const failed = (id: string, at: string) => glob({ id, failure: { reason: id, at } });
    const list = recentRoutineFailures(
      [failed('old', '2026-09-01T00:00:00.000Z'), failed('a', '2026-10-04T00:00:00.000Z'), failed('b', '2026-10-05T00:00:00.000Z'), glob()],
      '2026-09-28T00:00:00.000Z',
    );
    expect(list.map((f) => f.globId)).toEqual(['b', 'a']);
  });
});

describe('stuck hints on cards', () => {
  const later = new Date(Date.parse(NOW) + 20 * 60_000).toISOString();
  const head = 'abc1234';
  const sub = (patch: Parameters<typeof glob>[0]) =>
    glob({ type: 'sub', status: 'pr_open', updatedAt: NOW, pr: { number: 3, state: 'ready', headSha: head }, ...patch });

  it('flags a ready sub with no gate result after a while', () => {
    expect(stuckHint(sub({ headChecks: null }), later)).toMatch(/No sub-gate result/);
    expect(stuckHint(sub({ headChecks: null }), NOW)).toBeNull();
  });

  it('flags a passed gate that has not merged', () => {
    expect(stuckHint(sub({ headChecks: { sha: head, state: 'passed' } }), later)).toMatch(/passed but slop hasn't merged/);
  });

  it('says which glob caused a conflict, and suggests resolving locally when needed', () => {
    const conflict = { base: 'main', files: ['a.ts', 'b.ts'], since: 's1t2', at: NOW };
    const open = sub({ status: 'in_progress', conflict });
    expect(stuckHint(open, NOW)).toBe('Conflicts with main since s1t2 merged: a.ts, b.ts');
    expect(stuckHint(sub({ conflict: { ...conflict, since: null, files: [] } }), NOW)).toBe('Conflicts with main');
    // Asked the Claude GitHub App, and the PR still conflicts later.
    const asked = sub({ conflict: { ...conflict, requestedAt: NOW } });
    expect(stuckHint(asked, NOW)).not.toMatch(/Resolve locally/);
    expect(stuckHint(asked, later)).toMatch(/Resolve locally: sstor --glob s1t1 --resolve/);
    // A human implementer resolves locally from the start; a cleared conflict shows nothing.
    expect(stuckHint(sub({ conflict, implementer: 'dev@example.com' }), NOW)).toMatch(/Resolve locally/);
    expect(stuckHint(sub({ conflict: null }), NOW)).toBeNull();
  });

  it('shows the fix for a known routine failure, and nothing for ordinary globs', () => {
    expect(stuckHint(glob({ failure: { reason: 'Repository not found', at: NOW } }), later)).toMatch(/routine's repositories/);
    expect(stuckHint(glob({ status: 'in_progress' }), later)).toBeNull();
  });
});

describe('watching run that ignores failed checks', () => {
  const failedAt = '2026-09-30T10:00:00.000Z';
  const at = (min: number) => new Date(Date.parse(failedAt) + min * 60_000).toISOString();
  const head = 'abc1234';
  const run = (patch: Partial<ReturnType<typeof glob>['runs'][number]> = {}) => ({
    id: 'r1', state: 'watching' as const, outcome: null, generation: 1, triggeredBy: 'a', routineOwner: 'a',
    queuedAt: failedAt, startedAt: failedAt, lastProgressAt: failedAt, endedAt: null, failureReason: null,
    sessionId: 's', sessionUrl: 'https://claude.ai/code/s', ...patch,
  });
  const watched = (patch: Parameters<typeof glob>[0] = {}) =>
    glob({
      id: 's1t1', type: 'sub', status: 'pr_open', pr: { number: 3, state: 'ready', headSha: head },
      headChecks: { sha: head, state: 'failed', at: failedAt }, runs: [run()], ...patch,
    });

  it('hints with the take-over and session fixes after 15 minutes', () => {
    expect(stuckHint(watched(), at(14))).toBeNull();
    const hint = stuckHint(watched(), at(16));
    expect(hint).toMatch(/Checks failed on the head 16 minutes ago/);
    expect(hint).toContain('sstor --glob s1t1 --take-over');
    expect(hint).toContain('https://claude.ai/code/s');
  });

  it('applies to a same too', () => {
    expect(stuckHint(watched({ type: 'same' }), at(20))).toMatch(/Checks failed/);
  });

  it('clears on a push, run progress, run end or checks that pass', () => {
    expect(stuckHint(watched({ type: 'same', headChecks: null }), at(20))).toBeNull();
    expect(stuckHint(watched({ type: 'same', runs: [run({ lastProgressAt: at(10) })] }), at(20))).toBeNull();
    expect(stuckHint(watched({ type: 'same', runs: [run({ state: 'ended', outcome: 'failed' })] }), at(20))).toBeNull();
    expect(stuckHint(watched({ type: 'same', headChecks: { sha: head, state: 'passed' } }), at(20))).toBeNull();
    expect(stuckHint(watched({ type: 'same', headChecks: { sha: 'old', state: 'failed', at: failedAt } }), at(20))).toBeNull();
  });

  it('counts toward the Claude GitHub App readiness item', () => {
    expect(unreactedCheckFailures([watched(), watched({ id: 's1t2', headChecks: null })], at(20))).toEqual(['s1t1']);
    const items = readiness({ ...ready, unreactedCheckFailures: ['s1t1'] });
    expect(items.find((i) => i.key === 'claude_app')).toMatchObject({ state: 'failing' });
  });
});
