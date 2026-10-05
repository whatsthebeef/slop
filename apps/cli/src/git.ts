import { execFile } from 'node:child_process';
import { SlopError } from './errors.js';

/** How long one git command may take; a push talks to the remote. */
export const GIT_TIMEOUT_MS = 120_000;

/** The git operations the glob commands need; tests inject a fake. Every call runs in `root`. */
export interface Git {
  /** The checked-out branch, or undefined on a detached HEAD. */
  currentBranch(root: string): Promise<string | undefined>;
  /** Whether tracked files have staged or unstaged changes (untracked files don't count). */
  hasUncommittedChanges(root: string): Promise<boolean>;
  /** Untracked, non-ignored paths, relative to the root (a new directory is listed as `dir/`). */
  untrackedFiles(root: string): Promise<string[]>;
  push(root: string, branch: string): Promise<void>;
  /** Whether `origin` has the branch. */
  remoteBranchExists(root: string, branch: string): Promise<boolean>;
}

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git with an argument array (no shell) and resolves with its exit code and output. */
function runGit(root: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        // Fail instead of waiting on a credential prompt nobody may be there to answer.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        // A non-zero exit has a numeric code; a spawn failure (git missing) or timeout doesn't.
        if (typeof error.code === 'number' && error.killed !== true) {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        reject(new SlopError(`git ${args.join(' ')} failed: ${error.message}`));
      },
    );
  });
}

async function gitOrFail(root: string, args: readonly string[]): Promise<string> {
  const result = await runGit(root, args);
  if (result.code !== 0) {
    throw new SlopError(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export const systemGit: Git = {
  async currentBranch(root) {
    const branch = await gitOrFail(root, ['branch', '--show-current']);
    return branch === '' ? undefined : branch;
  },
  async hasUncommittedChanges(root) {
    const status = await gitOrFail(root, ['status', '--porcelain', '--untracked-files=no']);
    return status !== '';
  },
  async untrackedFiles(root) {
    // -z: NUL-separated, paths unquoted.
    const status = await gitOrFail(root, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=normal',
    ]);
    return status
      .split('\0')
      .filter((entry) => entry.startsWith('?? '))
      .map((entry) => entry.slice(3));
  },
  async push(root, branch) {
    await gitOrFail(root, ['push', 'origin', branch]);
  },
  async remoteBranchExists(root, branch) {
    // The full ref matches exactly (a bare name would also match x/<branch>) and can't be read
    // as an option. --exit-code: 2 when no ref matches; anything else non-zero is a failure.
    const result = await runGit(root, [
      'ls-remote',
      '--exit-code',
      'origin',
      `refs/heads/${branch}`,
    ]);
    if (result.code === 0) {
      return result.stdout.split('\n').some((line) => line.endsWith(`\trefs/heads/${branch}`));
    }
    if (result.code === 2) return false;
    throw new SlopError(`git ls-remote origin ${branch} failed: ${result.stderr.trim()}`);
  },
};
