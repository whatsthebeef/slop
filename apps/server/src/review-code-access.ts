import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CodeAccess, DirEntry, GrepMatch } from '@slop/core';
import { safeGrepPattern, safeRepoPath } from '@slop/core';
import type { CodeHost, Repo } from './codehost.js';

const run = promisify(execFile);

/** A clone is only searched; both git steps are bounded so a hung network can't hold a review. */
const GIT_TIMEOUT_MS = 90_000;
const GREP_OUTPUT_LIMIT = 1_000_000;

/**
 * git's own settings are ignored: no hooks, no system or user config, no prompts, and the token goes in an env header, not
 * argv or `.git/config`. `extra` adds more `-c` style settings (the code view's clones turn hooks off by path too).
 */
export const gitEnv = (token: string, extra: readonly (readonly [string, string])[] = []): NodeJS.ProcessEnv => {
  const settings: (readonly [string, string])[] = [['http.extraHeader', `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`], ...extra];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: tmpdir(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: String(settings.length),
  };
  settings.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${String(i)}`] = key;
    env[`GIT_CONFIG_VALUE_${String(i)}`] = value;
  });
  return env;
};

/**
 * Read-only code access for one review: `read_file` and `list_dir` through the code host's API, `grep` over a shallow,
 * checkout-less clone (a single-commit fetch into a temporary repository that is only searched with `git grep`) made on
 * the first search and deleted by `dispose`. No command other than `git init`, `git fetch` and `git grep` is ever run,
 * and nothing from the repository is checked out, installed, built or executed.
 */
export class HostCodeAccess implements CodeAccess {
  private clone: Promise<{ dir: string; env: NodeJS.ProcessEnv }> | null = null;

  /** `ref`: the PR's test-merge ref before merge, the base branch after. */
  constructor(
    private readonly host: CodeHost,
    private readonly repo: Repo,
    private readonly ref: string,
    /** Where the clone is fetched from; tests point it at a local repository. */
    private readonly remote: string = `https://github.com/${repo.owner}/${repo.name}.git`,
  ) {}

  readFile(path: string, signal?: AbortSignal): Promise<string | null> {
    return this.host.readFile(this.repo, this.ref, path, signal);
  }

  async listDir(path: string, signal?: AbortSignal): Promise<readonly DirEntry[] | null> {
    return this.host.listDir(this.repo, this.ref, path, signal);
  }

  async grep(pattern: string, limit: number, signal?: AbortSignal): Promise<readonly GrepMatch[]> {
    // The tools layer already vets the pattern; this is the last line before the command, so it is checked again.
    if (safeGrepPattern(pattern) === null) throw new Error('Invalid search pattern');
    const { dir, env } = await this.ensureClone(signal);
    try {
      const { stdout } = await run('git', ['grep', '-n', '-I', '-E', '--no-color', '--no-recurse-submodules', '-e', pattern, 'FETCH_HEAD', '--'], {
        cwd: dir,
        env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GREP_OUTPUT_LIMIT,
        signal,
      });
      return parseGrep(stdout, limit);
    } catch (error) {
      // Exit status 1 is "no matches"; a pattern git rejects exits 128 with its message, which the model can read.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) return [];
      if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string' && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return parseGrep(error.stdout, limit);
      }
      if (typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim() !== '') {
        throw new Error(error.stderr.trim().split('\n')[0] ?? 'search failed', { cause: error });
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const pending = this.clone;
    this.clone = null;
    if (pending === null) return;
    // A clone still being made is waited for, so its folder can't outlive the review.
    const made = await pending.catch(() => null);
    if (made !== null) await rm(made.dir, { recursive: true, force: true });
  }

  private ensureClone(signal?: AbortSignal): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
    this.clone ??= this.makeClone(signal);
    return this.clone;
  }

  private async makeClone(signal?: AbortSignal): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
    const dir = await mkdtemp(join(tmpdir(), 'slop-review-'));
    try {
      const env = gitEnv(await this.host.readToken(this.repo));
      const opts = { cwd: dir, env, timeout: GIT_TIMEOUT_MS, signal };
      await run('git', ['init', '--quiet'], opts);
      await run('git', ['fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules', this.remote, this.ref], opts);
      return { dir, env };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw new Error('The repository could not be cloned for searching', { cause: error });
    }
  }
}

/** `FETCH_HEAD:path:line:text` lines as matches; the first `limit`. */
export const parseGrep = (stdout: string, limit: number): GrepMatch[] => {
  const matches: GrepMatch[] = [];
  for (const row of stdout.split('\n')) {
    const found = /^FETCH_HEAD:(.+?):(\d+):(.*)$/.exec(row);
    if (found === null) continue;
    const path = safeRepoPath(found[1] ?? '');
    if (path === null || path === '') continue;
    matches.push({ path, line: Number(found[2]), text: found[3] ?? '' });
    if (matches.length >= limit) break;
  }
  return matches;
};
