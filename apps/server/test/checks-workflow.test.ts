import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(__dirname, '../../..');
const files = ['.github/workflows/checks.yml', 'catalog/scripts/checks.yml'];
// The repo's own workflow gates its jobs on the `changes` job (which plans everything for a push) and adds a final `checks` job that must run even when a job before it failed or was skipped.
const aggregate = (file: string, name: string) => file.startsWith('.github') && name === 'checks';
// A push has no pull_request object, so this guard only skips draft PRs.
const draftGuard = "${{ github.event_name == 'push' || !github.event.pull_request.draft }}";

describe.each(files)('%s', (file) => {
  const wf = parse(readFileSync(resolve(root, file), 'utf8')) as {
    on: Record<string, { types?: string[] } | undefined>;
    jobs: Record<string, { if?: string }>;
  };

  it('has no merge_group trigger (slop merges through its own merge line)', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['pull_request', 'push']);
  });

  it('skips no job except for a draft pull request', () => {
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
    jobs: Record<
      string,
      {
        if?: string;
        needs?: string | string[];
        permissions?: Record<string, string>;
        steps?: { name?: string; run?: string }[];
      }
    >;
  };
  const others = Object.keys(wf.jobs).filter((name) => name !== 'checks');
  const plan = wf.jobs.changes?.steps?.find((s) => s.name === 'Plan')?.run ?? '';

  it('ends in a `checks` job that needs every other job and runs even when one failed', () => {
    const checks = wf.jobs.checks;
    expect([checks?.needs ?? []].flat().sort()).toEqual([...others].sort());
    expect(checks?.if).toContain('always()');
    expect(
      checks?.steps?.some((s) => s.run?.includes('failure') && s.run.includes('cancelled')),
    ).toBe(true);
  });

  it('fails `checks` on a failed job, and cancels its run (not a failure) on a cancelled one', () => {
    const checks = wf.jobs.checks;
    const run = checks?.steps?.[0]?.run ?? '';
    expect(checks?.permissions).toEqual({ actions: 'write' });
    expect(run).toMatch(/\*" failure "\*\) exit 1 ;;/);
    expect(run).toContain('actions/runs/$GITHUB_RUN_ID/force-cancel');
    // The failure check comes first, so a run with both a failed and a cancelled job fails.
    expect(run.indexOf('" failure "')).toBeLessThan(run.indexOf('force-cancel'));
  });

  it('runs every lint, type check and test command under `timeout`, so a hang fails instead of cancelling', () => {
    const commands = Object.entries(wf.jobs)
      .filter(([name]) => name !== 'changes')
      .map(([, job]) => job)
      .flatMap((job) => job.steps ?? [])
      .flatMap((s) => (s.run ?? '').split('\n'))
      .filter((line) => /\bpnpm\b.*\b(lint|typecheck|test|eslint)\b/.test(line));
    expect(commands.length).toBeGreaterThan(0);
    for (const line of commands) expect(line).toMatch(/\btimeout \d+m pnpm\b/);
  });

  it('leaves the root workspace out of the affected type check', () => {
    const step = wf.jobs.typecheck?.steps?.find((s) => s.name === 'Type check');
    expect(step?.run).toContain(`--filter "...[origin/$BASE]" --filter '!{.}' typecheck`);
  });

  it('greps the changed and affected lists through here-strings, not pipes', () => {
    expect(plan).not.toMatch(/echo "\$(changed|affected)" \|/);
  });

  const hasBash = spawnSync('bash', ['--version']).status === 0;

  // Runs the Plan step with bash against a fake `git` (prints `changed`) and `pnpm` (prints `affected` as absolute
  // paths and records its arguments), and returns the step's outputs.
  const runPlan = (opts: {
    event?: string;
    changed?: string[];
    affected?: string[];
    files?: string[];
  }) => {
    const dir = mkdtempSync(join(tmpdir(), 'checks-plan-'));
    try {
      const bin = join(dir, 'bin');
      const work = join(dir, 'work');
      mkdirSync(bin);
      mkdirSync(work);
      for (const f of opts.files ?? []) {
        mkdirSync(dirname(join(work, f)), { recursive: true });
        writeFileSync(join(work, f), '');
      }
      writeFileSync(join(dir, 'changed'), (opts.changed ?? []).join('\n'));
      writeFileSync(join(dir, 'affected'), (opts.affected ?? []).map((a) => `${a}\n`).join(''));
      writeFileSync(
        join(bin, 'git'),
        '#!/usr/bin/env bash\nif [ "$1" = diff ]; then cat "$FAKE_DIR/changed"; fi\n',
      );
      writeFileSync(
        join(bin, 'pnpm'),
        '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$FAKE_DIR/pnpm-args"\n' +
          'while IFS= read -r a; do [ -n "$a" ] && echo "$PWD/$a"; done < "$FAKE_DIR/affected"\n',
      );
      chmodSync(join(bin, 'git'), 0o755);
      chmodSync(join(bin, 'pnpm'), 0o755);
      writeFileSync(join(dir, 'plan.sh'), plan);
      const output = join(dir, 'output');
      writeFileSync(output, '');
      const result = spawnSync('bash', [join(dir, 'plan.sh')], {
        cwd: work,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          FAKE_DIR: dir,
          EVENT: opts.event ?? 'pull_request',
          BASE: 'main',
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const out: Record<string, string> = {};
      const lines = readFileSync(output, 'utf8').split('\n');
      for (let n = 0; n < lines.length; n++) {
        const line = lines[n] ?? '';
        const heredoc = /^(\w+)<<(\S+)$/.exec(line);
        if (heredoc?.[1] && heredoc[2]) {
          const end = lines.indexOf(heredoc[2], n + 1);
          out[heredoc[1]] = lines.slice(n + 1, end).join('\n');
          n = end;
        } else if (line.includes('=')) {
          out[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1);
        }
      }
      const pnpmArgs = existsSync(join(dir, 'pnpm-args'))
        ? readFileSync(join(dir, 'pnpm-args'), 'utf8').trimEnd().split('\n')
        : undefined;
      return { out, pnpmArgs };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const suites = ['core', 'server', 'web', 'cli', 'infra', 'catalog'] as const;
  // The suites that ran, plus lint and typecheck.
  const ran = (out: Record<string, string>) =>
    [...suites, 'lint', 'typecheck'].filter((k) => out[k] === 'true');
  const full = [...suites, 'lint', 'typecheck'];

  describe.skipIf(!hasBash)('Plan step', () => {
    it('runs everything for a push, without diffing', () => {
      const { out, pnpmArgs } = runPlan({ event: 'push' });
      expect(ran(out)).toEqual(full);
      expect(out.full).toBe('true');
      expect(pnpmArgs).toBeUndefined();
    });

    it('runs only web, its lint and the type check for a web-only pull request', () => {
      const { out, pnpmArgs } = runPlan({
        changed: ['apps/web/src/app.tsx'],
        affected: ['apps/web'],
      });
      expect(ran(out)).toEqual(['web', 'lint', 'typecheck']);
      expect(out.full).toBe('false');
      expect(out.lint_paths).toBe('apps/web');
      // The root workspace is left out of the affected set.
      expect(pnpmArgs).toContain('...[origin/main]');
      expect(pnpmArgs?.join(' ')).toContain('--filter ...[origin/main] --filter !{.}');
    });

    it('runs core and its dependents for a core change, and lints them whole', () => {
      const affected = ['packages/core', 'apps/server', 'apps/web', 'apps/cli'];
      const { out } = runPlan({ changed: ['packages/core/src/glob.ts'], affected });
      expect(ran(out)).toEqual(['core', 'server', 'web', 'cli', 'lint', 'typecheck']);
      expect(out.lint_paths?.split('\n')).toEqual(affected);
    });

    it('runs the repo-reading suites, without web or a type check, for a scripts/ change', () => {
      const { out } = runPlan({ changed: ['scripts/dev.sh'] });
      expect(ran(out)).toEqual(['core', 'server', 'cli', 'infra']);
    });

    it('adds the catalog shell tests for a catalog change', () => {
      const { out } = runPlan({ changed: ['catalog/scripts/setup-repo.sh'] });
      expect(ran(out)).toEqual(['core', 'server', 'cli', 'infra', 'catalog']);
    });

    it('lints changed files outside the workspaces that still exist', () => {
      const { out } = runPlan({
        changed: ['scripts/kept.mjs', 'scripts/deleted.ts', 'docs/notes.md'],
        files: ['scripts/kept.mjs'],
      });
      expect(out.lint).toBe('true');
      expect(out.lint_paths).toBe('scripts/kept.mjs');
      expect(out.typecheck).toBe('false');
    });

    it.each([['pnpm-lock.yaml'], ['.github/workflows/checks.yml'], ['package.json']])(
      'runs everything when %s changes',
      (root) => {
        const { out, pnpmArgs } = runPlan({ changed: ['apps/web/src/app.tsx', root] });
        expect(ran(out)).toEqual(full);
        expect(out.full).toBe('true');
        expect(pnpmArgs).toBeUndefined();
      },
    );

    it('still runs everything for a large diff with a root file first', () => {
      const changed = [
        'package.json',
        ...Array.from({ length: 5000 }, (_, n) => `apps/web/src/generated/file-${String(n)}.ts`),
      ];
      const { out } = runPlan({ changed, affected: ['apps/web'] });
      expect(out.full).toBe('true');
      expect(ran(out)).toEqual(full);
    });
  });
});
