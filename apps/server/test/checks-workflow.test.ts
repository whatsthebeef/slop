import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(__dirname, '../../..');
const files = ['.github/workflows/checks.yml', 'catalog/scripts/checks.yml'];
// The repo's own workflow gates its jobs on the `changes` job (which runs for a merge group and plans everything) and adds a final `checks` job that must run even when a job before it failed or was skipped.
const aggregate = (file: string, name: string) => file.startsWith('.github') && name === 'checks';
// A merge_group event has no pull_request object, so this draft guard evaluates true for it.
const draftGuard = "${{ github.event_name == 'push' || !github.event.pull_request.draft }}";

describe.each(files)('%s', (file) => {
  const wf = parse(readFileSync(resolve(root, file), 'utf8')) as {
    on: Record<string, { types?: string[] } | undefined>;
    jobs: Record<string, { if?: string }>;
  };

  it('runs on merge_group checks_requested', () => {
    expect(wf.on.merge_group?.types).toEqual(['checks_requested']);
  });

  it('skips no job for a merge group', () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (aggregate(file, name)) continue;
      expect(
        job.if === undefined || job.if === draftGuard || job.if.includes('needs.changes.outputs.'),
      ).toBe(true);
    }
  });
});

describe('.github/workflows/checks.yml structure', () => {
  const text = readFileSync(resolve(root, '.github/workflows/checks.yml'), 'utf8');
  const wf = parse(text) as {
    jobs: Record<string, { if?: string; needs?: string | string[]; steps?: { run?: string }[] }>;
  };
  const others = Object.keys(wf.jobs).filter((name) => name !== 'checks');

  it('ends in a `checks` job that needs every other job and runs even when one failed', () => {
    const checks = wf.jobs.checks;
    expect([...(checks.needs as string[])].sort()).toEqual([...others].sort());
    expect(checks.if).toContain('always()');
    expect(
      checks.steps?.some((s) => s.run?.includes('failure') && s.run.includes('cancelled')),
    ).toBe(true);
  });

  it('runs everything for a push, and only affected workspaces for a pull request', () => {
    const plan = wf.jobs.changes.steps?.find((s) => s.run?.includes('GITHUB_OUTPUT'))?.run ?? '';
    expect(plan).toContain('"$EVENT" != pull_request');
    expect(plan).toContain('--filter "...[origin/$BASE]"');
  });

  it('falls back to the full suite when a root file changes', () => {
    const plan = wf.jobs.changes.steps?.find((s) => s.run?.includes('GITHUB_OUTPUT'))?.run ?? '';
    for (const f of ['package\\.json', 'pnpm-lock\\.yaml', 'eslint\\.config\\.js', '\\.github/']) {
      expect(plan).toContain(f);
    }
  });
});
