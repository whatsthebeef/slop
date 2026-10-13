import { describe, expect, it } from 'vitest';
import type { MachineStep } from '../src/domain/machine-steps.js';
import { DEFAULT_STALL_MINUTES, isStale, machineSteps, quietMinutes, stallThresholds } from '../src/domain/machine-steps.js';
import { NOW, board, glob, run } from './fixtures.js';

const minutesAgo = (n: number) => new Date(Date.parse(NOW) - n * 60_000).toISOString();
const kinds = (g = glob(), facts = {}) => machineSteps(g, facts).map((s) => [s.kind, s.state]);

describe('machineSteps: runs', () => {
  it('an active run is an implement step holding the ball', () => {
    const [s] = machineSteps(glob({ status: 'in_progress', runs: [run({ sessionUrl: 'https://claude.ai/s' })] }));
    expect(s).toMatchObject({ kind: 'implement', state: 'running', holdsBall: true, detail: 'https://claude.ai/s' });
  });

  it('names the work: investigate, fix checks, answer review, resolve conflict', () => {
    expect(kinds(glob({ status: 'planning', runs: [run({ purpose: 'investigate' })] }))).toEqual([['investigate', 'running']]);
    expect(kinds(glob({ status: 'in_progress', runs: [run({ purpose: 'resolve_conflict' })] }))).toEqual([['resolve_conflict', 'running']]);
    expect(kinds(glob({ status: 'reviewing', runs: [run()] }))).toEqual([['answer_review', 'running']]);
    const failing = glob({ status: 'pr_open', runs: [run()], headChecks: { sha: 'aaa', state: 'failed' } });
    expect(kinds(failing)).toEqual([['fix_checks', 'running']]);
  });

  it('checks that fail the same way on the base are not this glob to fix', () => {
    const inherited = glob({ status: 'in_progress', runs: [run()], headChecks: { sha: 'aaa', state: 'failed', inheritedFrom: { base: 'main', since: 's1t0' } } });
    expect(kinds(inherited)).toEqual([['implement', 'running']]);
  });

  it('a queued run is queued and holds the ball; a watching run is standby and never does', () => {
    expect(machineSteps(glob({ status: 'implementing', runs: [run({ state: 'queued', startedAt: null })] }))[0]).toMatchObject({ state: 'queued', holdsBall: true, startedAt: NOW });
    expect(machineSteps(glob({ status: 'pr_open', runs: [run({ state: 'watching' })] }))[0]).toMatchObject({ kind: 'standby', state: 'standby', holdsBall: false });
  });

  it('an ended run is no step', () => {
    expect(kinds(glob({ runs: [run({ state: 'ended', outcome: 'completed' })] }))).toEqual([]);
  });

  it('a failure leaves a failed step that holds nothing, by what failed', () => {
    const failed = (kind?: 'merge' | 'provisioning') =>
      glob({ status: 'failed', failure: { reason: 'boom', at: NOW, ...(kind === undefined ? {} : { kind }) } });
    expect(machineSteps(failed())[0]).toMatchObject({ kind: 'implement', state: 'failed', holdsBall: false, detail: 'boom' });
    expect(kinds(failed('merge'))).toEqual([['merge', 'failed']]);
    expect(kinds(failed('provisioning'))).toEqual([['provision', 'failed']]);
  });
});

describe('machineSteps: other sources', () => {
  it('provisioning: pending is running, failed is failed', () => {
    expect(kinds(glob({ provisioning: 'pending' }))).toEqual([['provision', 'running']]);
    expect(kinds(glob({ provisioning: 'failed' }))).toEqual([['provision', 'failed']]);
    expect(kinds(glob({ provisioning: 'ok' }))).toEqual([]);
  });

  it('head checks pending: a checks step that waits, never holds the ball', () => {
    const [s] = machineSteps(glob({ status: 'pr_open', headChecks: { sha: 'abc1234def', state: 'pending' } }));
    expect(s).toMatchObject({ kind: 'checks', state: 'running', holdsBall: false, detail: 'abc1234' });
    expect(kinds(glob({ status: 'pr_open', headChecks: { sha: 'abc', state: 'passed' } }))).toEqual([]);
  });

  it('a ready PR with no check reported on its head yet: a queued checks step', () => {
    const ready = glob({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: 'abc1234def' }, headChecks: null });
    expect(machineSteps(ready)[0]).toMatchObject({ kind: 'checks', state: 'queued', holdsBall: false, detail: 'abc1234' });
    expect(machineSteps({ ...ready, headChecks: { sha: 'abc1234def', state: 'passed' } })).toEqual([]);
    expect(machineSteps({ ...ready, pr: { number: 7, state: 'draft', headSha: 'abc1234def' } })).toEqual([]);
  });

  it('merge when green: the checks hold the ball until they pass, then slop does', () => {
    const armed = (state: 'pending' | 'passed') => glob({ status: 'pr_open', mergeMode: 'when_green', headChecks: { sha: 'abc', state } });
    expect(machineSteps(armed('pending')).find((s) => s.kind === 'merge')?.holdsBall).toBe(false);
    expect(machineSteps(armed('passed')).find((s) => s.kind === 'merge')).toMatchObject({ state: 'queued', holdsBall: true });
    expect(kinds(glob({ status: 'merging' }))).toEqual([['merge', 'running']]);
  });

  it('deploys: a running or waiting deploy is a deploy step that waits; finished ones are ignored', () => {
    const d = (id: string, state: 'waiting' | 'running' | 'succeeded' | 'failed') => ({ id, environment: 'dev', sha: 'abc', state, requestedAt: NOW, runningSince: null, url: null });
    const steps = machineSteps(glob(), { deploys: [d('1', 'running'), d('2', 'waiting'), d('3', 'succeeded'), d('4', 'failed')] });
    expect(steps.map((s) => [s.kind, s.state, s.holdsBall, s.detail])).toEqual([
      ['deploy', 'running', false, 'dev'],
      ['deploy', 'queued', false, 'dev'],
    ]);
  });

  it('size check, learning pipeline and unseen uploads', () => {
    expect(machineSteps(glob(), { sizeCheck: { since: NOW } })[0]).toMatchObject({ kind: 'size_check', state: 'running', holdsBall: true });
    expect(machineSteps(glob(), { pipeline: { state: 'running', since: NOW } })[0]).toMatchObject({ kind: 'learning_pipeline', holdsBall: true });
    expect(machineSteps(glob(), { pipeline: { state: 'failed', since: NOW } })[0]).toMatchObject({ state: 'failed', holdsBall: false });
    expect(machineSteps(glob(), { pendingUploads: [{ key: 'k', fileName: 'a.png', since: NOW }] })[0]).toMatchObject({ kind: 'upload_wait', holdsBall: false, detail: 'a.png' });
  });

  it('effects: the ones that are a step of their own show; housekeeping does not', () => {
    const effects = [
      { kind: 'review_change', state: 'running' as const, since: NOW },
      { kind: 'squash_merge', state: 'queued' as const, since: NOW },
      { kind: 'commit_agent_set', state: 'failed' as const, since: NOW, error: 'denied' },
      { kind: 'sync_pr_labels', state: 'queued' as const, since: NOW },
    ];
    expect(machineSteps(glob(), { effects }).map((s) => [s.kind, s.state, s.holdsBall])).toEqual([
      ['review_code', 'running', true],
      ['merge', 'queued', true],
      ['agent_set_commit', 'failed', false],
    ]);
  });

  it('an effect that repeats provisioning or the pipeline fact adds no second step', () => {
    expect(machineSteps(glob({ provisioning: 'pending' }), { effects: [{ kind: 'provision', state: 'queued', since: NOW }] })).toHaveLength(1);
    expect(machineSteps(glob(), { pipeline: { state: 'running', since: NOW }, effects: [{ kind: 'kb_route', state: 'running', since: NOW }] })).toHaveLength(1);
  });

  it('standby never holds the ball, whatever else is on the glob', () => {
    const steps = machineSteps(glob({ status: 'pr_open', runs: [run({ state: 'watching' })], headChecks: { sha: 'a', state: 'pending' } }));
    expect(steps.filter((s) => s.holdsBall)).toEqual([]);
  });
});

describe('stall thresholds', () => {
  it('defaults, held below the board timeouts that fail the run', () => {
    expect(stallThresholds()).toEqual(DEFAULT_STALL_MINUTES);
    expect(stallThresholds(board)).toMatchObject({ implement: 45, queued: 20 });
    expect(stallThresholds({ runNoProgressHours: 1, runStartMinutes: 10 })).toMatchObject({ implement: 45, queued: 7 });
    expect(stallThresholds({ runNoProgressHours: 0.5, runStartMinutes: 10 }).implement).toBe(22);
  });

  it('a running step is quiet since its last sign of life, a queued one since it was queued', () => {
    const t = DEFAULT_STALL_MINUTES;
    const working = (progress: number) => machineSteps(glob({ status: 'in_progress', runs: [run({ startedAt: minutesAgo(200), lastProgressAt: minutesAgo(progress) })] }))[0] as MachineStep;
    expect(isStale(working(44), NOW, t)).toBe(false);
    expect(isStale(working(45), NOW, t)).toBe(true);
    const queued = machineSteps(glob({ status: 'implementing', runs: [run({ state: 'queued', startedAt: null, queuedAt: minutesAgo(25), lastProgressAt: null })] }))[0] as MachineStep;
    expect(quietMinutes(queued, NOW)).toBe(25);
    expect(isStale(queued, NOW, t)).toBe(true);
  });

  it('a provision step goes stale sooner; a failed or standby step never does', () => {
    const t = DEFAULT_STALL_MINUTES;
    const provisioning = machineSteps(glob({ provisioning: 'pending', doingSince: minutesAgo(11) }))[0] as MachineStep;
    expect(isStale(provisioning, NOW, t)).toBe(true);
    const standby = machineSteps(glob({ runs: [run({ state: 'watching', lastProgressAt: minutesAgo(999) })] }))[0] as MachineStep;
    expect(isStale(standby, NOW, t)).toBe(false);
  });
});
