import { describe, expect, it } from 'vitest';
import type { GlobView } from '@/lib/api';
import { statusLine } from '@/lib/status-line';

const NOW = '2026-10-08T12:00:00.000Z';
const HEAD = 'abc1234def';
const URL_ = 'https://github.com/acme/app/actions/runs/1/job/2';

const run = (patch = {}) => ({
  id: 'run-1',
  state: 'watching',
  outcome: null,
  generation: 1,
  triggeredBy: 'dev@example.com',
  routineOwner: 'dev@example.com',
  queuedAt: NOW,
  startedAt: NOW,
  endedAt: null,
  failureReason: null,
  sessionId: 's',
  sessionUrl: 'https://claude.ai/code/s',
  lastProgressAt: NOW,
  ...patch,
});

const glob = (patch: Record<string, unknown> = {}): GlobView =>
  ({
    id: 's1t1',
    boardId: 1,
    title: 'T',
    summary: '',
    type: 'sub',
    category: 'task',
    group: null,
    environment: null,
    status: 'pr_open',
    version: 1,
    generation: 1,
    creator: 'dev@example.com',
    planner: 'dev@example.com',
    implementer: null,
    labels: {},
    checklists: {},
    pr: { number: 7, state: 'ready', headSha: HEAD },
    prs: [],
    mergeMode: null,
    headChecks: null,
    runs: [],
    currentRun: null,
    failure: null,
    provisioning: 'ok',
    createdAt: NOW,
    updatedAt: NOW,
    signedOffAt: null,
    doingSince: null,
    ...patch,
  }) as unknown as GlobView;

const failedChecks = (extra = {}) => ({
  sha: HEAD,
  state: 'failed',
  failure: { name: 'Check', step: 'Type check', lines: ['packages/core: error TS2322'], url: URL_ },
  ...extra,
});

describe('statusLine', () => {
  it('shows failed checks on a sub, in full, with the log and the fixing session', () => {
    const g = glob({ headChecks: failedChecks(), runs: [run()], currentRun: run() });
    const s = statusLine(g, NOW);
    expect(s?.kind).toBe('checks');
    expect(s?.full).toContain('packages/core: error TS2322');
    expect(s?.url).toBe(URL_);
    expect(s?.doing).toEqual({ text: 'routine session is fixing it', url: 'https://claude.ai/code/s' });
  });

  it('says the base is red and the branch updates when it is fixed', () => {
    const g = glob({ headChecks: failedChecks({ inheritedFrom: { base: 'main', since: 's1t0', sha: 'm1' } }) });
    const s = statusLine(g, NOW);
    expect(s?.kind).toBe('base-red');
    expect(s?.doing?.text).toMatch(/base is fixed/);
  });

  it('shows a run failure', () => {
    const s = statusLine(glob({ status: 'failed', failure: { reason: 'Routine run failed: boom' } }), NOW);
    expect(s?.kind).toBe('failure');
    expect(s?.full).toBe('Routine run failed: boom');
  });

  it('shows a stuck hint, cut to its first sentence', () => {
    const g = glob({ headChecks: { sha: HEAD, state: 'passed' }, updatedAt: '2026-10-08T10:00:00.000Z' });
    const s = statusLine(g, NOW);
    expect(s?.kind).toBe('stuck');
    expect(s?.full).toMatch(/^The sub-gate passed but slop hasn't merged it/);
  });

  it('shows ready to merge for a same with passed checks', () => {
    const g = glob({ type: 'same', headChecks: { sha: HEAD, state: 'passed' } });
    expect(statusLine(g, NOW)).toMatchObject({ kind: 'ready', text: 'Ready to merge', full: 'Ready to merge' });
  });

  it('is null when there is nothing to say', () => {
    expect(statusLine(glob({ status: 'planning', pr: null }), NOW)).toBeNull();
  });
});
