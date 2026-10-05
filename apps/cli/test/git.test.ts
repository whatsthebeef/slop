import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemGit } from '../src/git.js';

describe('systemGit', () => {
  let dir: string;
  let work: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slop-git-'));
    const origin = join(dir, 'origin.git');
    work = join(dir, 'work');
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    git(dir, 'init', '--quiet', '--initial-branch=main', work);
    git(work, 'remote', 'add', 'origin', origin);
    writeFileSync(join(work, 'a.txt'), 'one\n');
    git(work, 'add', 'a.txt');
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@x.test', 'commit', '--quiet', '-m', 'one');
    git(work, 'switch', '--quiet', '-c', 's1t4');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the branch, sees tracked changes only, pushes and finds the remote branch', async () => {
    expect(await systemGit.currentBranch(work)).toBe('s1t4');
    writeFileSync(join(work, 'untracked.txt'), 'x\n');
    expect(await systemGit.hasUncommittedChanges(work)).toBe(false);
    writeFileSync(join(work, 'a.txt'), 'two\n');
    expect(await systemGit.hasUncommittedChanges(work)).toBe(true);

    expect(await systemGit.remoteBranchExists(work, 's1t4')).toBe(false);
    await systemGit.push(work, 's1t4');
    expect(await systemGit.remoteBranchExists(work, 's1t4')).toBe(true);
  });

  it('lists untracked files and matches the remote branch by its full ref', async () => {
    writeFileSync(join(work, 'new.ts'), 'x\n');
    writeFileSync(join(work, 'with space.ts'), 'x\n');
    expect((await systemGit.untrackedFiles(work)).sort()).toEqual(['new.ts', 'with space.ts']);

    git(work, 'switch', '--quiet', '-c', 'x/s1t5');
    await systemGit.push(work, 'x/s1t5');
    expect(await systemGit.remoteBranchExists(work, 's1t5')).toBe(false);
    expect(await systemGit.remoteBranchExists(work, 'x/s1t5')).toBe(true);
  });

  it('fails with the git error when a push is refused', async () => {
    await expect(systemGit.push(work, 'no-such-branch')).rejects.toThrow(
      /git push origin no-such-branch failed/,
    );
  });
});
