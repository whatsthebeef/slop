import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { flakyTests } from '../../../scripts/flaky-tests.mjs';

const root = resolve(__dirname, '../../..');

describe('flaky-tests script', () => {
  it('lists passed tests that carry failure messages, and nothing else', () => {
    const report = {
      testResults: [
        {
          name: `${process.cwd()}/test/a.test.ts`,
          assertionResults: [
            { fullName: 'a retried', status: 'passed', failureMessages: ['Error: timed out\n at x'] },
            { fullName: 'a clean', status: 'passed', failureMessages: [] },
            { fullName: 'a broken', status: 'failed', failureMessages: ['Error: boom'] },
          ],
        },
      ],
    };
    expect(flakyTests(report)).toEqual([{ file: 'test/a.test.ts', test: 'a retried', failures: ['Error: timed out'] }]);
  });
});

describe('test-server job', () => {
  const wf = parse(readFileSync(resolve(root, '.github/workflows/checks.yml'), 'utf8')) as {
    jobs: Record<string, { strategy?: { matrix?: { shard?: string[] } }; services?: { postgres?: { options?: string } }; steps?: { name?: string; run?: string }[] }>;
  };
  const job = wf.jobs['test-server'];

  it('runs two shards as separate jobs', () => {
    expect(job?.strategy?.matrix?.shard).toEqual(['1/2', '2/2']);
    expect(job?.steps?.some((s) => s.run?.includes('--shard=${{ matrix.shard }}'))).toBe(true);
  });

  it('keeps Postgres data on tmpfs and turns durability off', () => {
    expect(job?.services?.postgres?.options).toContain('--tmpfs /var/lib/postgresql/data');
    const tune = job?.steps?.find((s) => s.name === 'Tune Postgres for tests')?.run ?? '';
    for (const setting of ['fsync = off', 'synchronous_commit = off', 'full_page_writes = off']) expect(tune).toContain(setting);
  });

  it('reports retried tests', () => {
    expect(job?.steps?.some((s) => s.run?.includes('--reporter=json'))).toBe(true);
  });

  it('caps the pool and retries once, in CI only', () => {
    const text = readFileSync(resolve(root, 'apps/server/vitest.config.ts'), 'utf8');
    expect(text).toMatch(/ci \? \{ pool: 'forks'.*maxWorkers: 2, retry: 1/);
  });
});
