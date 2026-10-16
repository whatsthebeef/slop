import { describe, expect, it } from 'vitest';
import { explodeCommands, isCommandSpan } from '@/lib/command-text';

describe('explodeCommands', () => {
  it('lifts an inline command span into its own fenced block', () => {
    const out = explodeCommands('Run `bash .reviews/s14b3-check.sh <profile>` in the repo.');
    expect(out).toContain('\n```\nbash .reviews/s14b3-check.sh <profile>\n```\n');
    expect(out).not.toContain('`bash .reviews');
  });

  it('leaves other code spans, lone tool names and fenced blocks alone', () => {
    expect(explodeCommands('Use `git` or the `foo` field.')).toBe('Use `git` or the `foo` field.');
    const fenced = 'Do:\n```\nrun `git status` here\n```';
    expect(explodeCommands(fenced)).toBe(fenced);
  });

  it('knows the command starters', () => {
    for (const c of ['sh a.sh', 'aws s3 ls', 'gh pr view', 'sstor --ready', 'slop x', 'pnpm test', 'npm i', 'export A=1', 'unset A', 'cd x', 'curl -s y', './run.sh'])
      expect(isCommandSpan(c)).toBe(true);
    expect(isCommandSpan('git')).toBe(false);
  });
});
