import { describe, expect, it } from 'vitest';
import { readCommitChecks } from '../src/github/commit-checks.js';
import type { Request } from '../src/github/commit-checks.js';

const repo = { owner: 'acme', name: 'app', base: 'main' };

const run = (patch: Record<string, unknown>) => ({
  id: 11,
  name: 'Check',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/acme/app/actions/runs/1/job/11',
  completed_at: '2026-10-07T10:00:00Z',
  output: { title: null, summary: null },
  ...patch,
});

/** A fake GitHub: check runs for the commit, and the job's steps and log by job ID. */
const fakeGitHub = (opts: { runs: unknown[]; steps?: unknown[]; log?: string | Error }): { request: Request; calls: string[] } => {
  const calls: string[] = [];
  const request: Request = (route) => {
    calls.push(route);
    if (route.endsWith('/check-runs')) return Promise.resolve({ data: { check_runs: opts.runs } });
    if (route.endsWith('/logs')) {
      return opts.log instanceof Error || opts.log === undefined ? Promise.reject(opts.log ?? new Error('404')) : Promise.resolve({ data: opts.log });
    }
    return Promise.resolve({ data: { steps: opts.steps ?? [] } });
  };
  return { request, calls };
};

const LOG = [
  ...Array.from({ length: 200 }, (_, i) => `2026-10-07T10:00:00.0000000Z noise ${String(i)}`),
  "2026-10-07T10:01:00.0000000Z apps/server/test/kb-routes.test.ts(31,7): error TS2739: Property 'commentOnce' is missing in type",
  '2026-10-07T10:01:01.0000000Z ##[error]Process completed with exit code 2.',
].join('\n');

describe('reading why a commit failed', () => {
  it('names the failing check, its failed step and the first error lines of the log tail', async () => {
    const { request } = fakeGitHub({
      runs: [run({ conclusion: 'failure' })],
      steps: [
        { name: 'Install', conclusion: 'success' },
        { name: 'Type check', conclusion: 'failure' },
        { name: 'Test', conclusion: 'skipped' },
      ],
      log: LOG,
    });
    const result = await readCommitChecks(request, repo, 'abc');
    expect(result.state).toBe('failed');
    expect(result.failure).toEqual({
      name: 'Check',
      step: 'Type check',
      lines: ["apps/server/test/kb-routes.test.ts(31,7): error TS2739: Property 'commentOnce' is missing in type", 'Process completed with exit code 2.'],
      url: 'https://github.com/acme/app/actions/runs/1/job/11',
    });
  });

  it('explains a failure with the job\'s error, not the Postgres service container log after cleanup', async () => {
    const log = [
      ...Array.from({ length: 300 }, (_, i) => `2026-10-07T10:00:00.0000000Z noise ${String(i)}`),
      '2026-10-07T10:01:00.0000000Z ##[error]  19:32  error  Unsafe return of a value of type any',
      '2026-10-07T10:01:00.1000000Z ##[error]✖ 18 problems (18 errors, 0 warnings)',
      '2026-10-07T10:01:01.0000000Z ##[error]Process completed with exit code 1.',
      '2026-10-07T10:01:02.0000000Z Post job cleanup.',
      ...Array.from({ length: 70 }, (_, i) => `2026-10-07T10:01:03.0000000Z postgres service line ${String(i)}`),
      '2026-10-07T10:01:09.0000000Z LOG: background worker "logical replication launcher" (PID 54) exited with exit code 1',
    ].join('\n');
    const { request } = fakeGitHub({ runs: [run({ conclusion: 'failure' })], log });
    const lines = (await readCommitChecks(request, repo, 'abc')).failure?.lines ?? [];
    expect(lines[0]).toBe('19:32  error  Unsafe return of a value of type any');
    expect(lines.join('\n')).not.toMatch(/postgres|logical replication/);
  });

  it('only reads the tail of a long log', async () => {
    const early = ['error: from the start of the job', ...Array.from({ length: 100 }, (_, i) => `line ${String(i)}`)].join('\n');
    const { request } = fakeGitHub({ runs: [run({ conclusion: 'failure' })], log: early });
    const result = await readCommitChecks(request, repo, 'abc');
    expect(result.failure?.lines).not.toContain('error: from the start of the job');
  });

  it("explains the earliest failure when several checks failed, and says nothing of passing ones", async () => {
    const { request } = fakeGitHub({
      runs: [
        run({ id: 1, name: 'Late', conclusion: 'failure', completed_at: '2026-10-07T10:09:00Z' }),
        run({ id: 2, name: 'Early', conclusion: 'timed_out', completed_at: '2026-10-07T10:02:00Z' }),
        run({ id: 3, name: 'Fine' }),
      ],
      log: 'error: boom',
    });
    expect((await readCommitChecks(request, repo, 'abc')).failure?.name).toBe('Early');
  });

  it("falls back to the run's own output when there is no log, and still names the check", async () => {
    const { request } = fakeGitHub({
      runs: [run({ conclusion: 'failure', output: { title: 'Lint failed', summary: '3 errors in src/a.ts' } })],
      log: new Error('Not Found'),
    });
    const result = await readCommitChecks(request, repo, 'abc');
    expect(result.state).toBe('failed');
    expect(result.failure).toMatchObject({ name: 'Check', step: null, lines: ['Lint failed', '3 errors in src/a.ts'] });

    const bare = fakeGitHub({ runs: [run({ conclusion: 'failure' })], log: new Error('Not Found') });
    expect((await readCommitChecks(bare.request, repo, 'abc')).failure).toMatchObject({ name: 'Check', lines: [] });
  });

  it('reports passed and pending without reading any log', async () => {
    const passed = fakeGitHub({ runs: [run({})] });
    expect(await readCommitChecks(passed.request, repo, 'abc')).toEqual({ state: 'passed', failure: null });
    const pending = fakeGitHub({ runs: [run({}), run({ id: 2, status: 'in_progress', conclusion: null })] });
    expect(await readCommitChecks(pending.request, repo, 'abc')).toEqual({ state: 'pending', failure: null });
    expect(passed.calls).toHaveLength(1);
    expect(pending.calls).toHaveLength(1);
  });
});
