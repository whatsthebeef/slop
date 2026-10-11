import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { CodeViewUnavailable, safeRef } from '@slop/core';
import type { CodeHost, Repo } from './codehost.js';
import { gitEnv } from './review-code-access.js';

const run = promisify(execFile);

/** Every git call is bounded, so a hung network or a huge repository can't hold a request or a job. */
const GIT_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 8_000_000;
/** A branch or PR head fetched on demand is fetched again after this long, so a moved branch is seen. */
const REF_FRESH_MS = 30_000;
/** On-demand refs older than this are dropped by cleanup. */
const REF_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** How much history the base branch's clone keeps (path history reads it); a clone over its cap shrinks to the second. */
const BASE_DEPTH = 500;
const SHRUNK_DEPTH = 50;
const BASE_REF = 'refs/slop/base';
const EXTRA_REFS = 'refs/slop/x';
const SHA = /^[0-9a-f]{40}$/;

export const DEFAULT_CAP_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * One bare clone per board under `dir` (`<dir>/<boardId>.git`): the base branch at `refs/slop/base`, kept up to date by
 * `sync`, and other refs (a PR head, a branch, a sha) fetched on demand under `refs/slop/x/`. A clone is only ever read:
 * nothing is checked out, and git runs with every hook, user config and prompt disabled and no submodule recursion, so
 * nothing in the repository can run. Fetches for one board are serialised; the disk use of each clone is capped.
 */
export class CodeClones {
  private readonly chains = new Map<number, Promise<unknown>>();
  private readonly fetchedAt = new Map<string, number>();
  private readonly capBytes: number;
  private readonly remote: (repo: Repo) => string;
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      readonly dir: string;
      readonly host: Pick<CodeHost, 'readToken'>;
      readonly capBytes?: number;
      /** Where a repo is fetched from; tests point it at a local repository. */
      readonly remote?: (repo: Repo) => string;
      readonly now?: () => number;
      readonly warn?: (message: string) => void;
    },
  ) {
    this.capBytes = opts.capBytes ?? DEFAULT_CAP_BYTES;
    this.remote = opts.remote ?? ((repo) => `https://github.com/${repo.owner}/${repo.name}.git`);
    this.now = opts.now ?? Date.now;
  }

  clonePath(boardId: number): string {
    return join(this.opts.dir, `${String(boardId)}.git`);
  }

  /** Fetches the base branch. `changed` is false when it was already at the remote's head. */
  sync(boardId: number, repo: Repo): Promise<{ sha: string; changed: boolean }> {
    return this.exclusive(boardId, async () => {
      const before = await this.revParse(boardId, BASE_REF);
      await this.fetch(boardId, repo, `+refs/heads/${this.branchOf(repo)}:${BASE_REF}`, BASE_DEPTH);
      const sha = await this.revParse(boardId, BASE_REF);
      if (sha === null) throw new Error(`The base branch ${repo.base} was not fetched`);
      await this.enforceCap(boardId, repo);
      return { sha, changed: sha !== before };
    });
  }

  /**
   * The commit `ref` names in the clone, fetching it first when the clone lacks it. `null` (or the base branch's own name)
   * is the base branch. Throws `CodeViewUnavailable` when the ref can't be fetched: the caller may fall back to the host's API.
   */
  async resolve(boardId: number, repo: Repo, ref: string | null): Promise<string> {
    if (ref === null || ref === repo.base) {
      const known = await this.revParse(boardId, BASE_REF);
      if (known !== null) return known;
      try {
        return (await this.sync(boardId, repo)).sha;
      } catch (error) {
        throw new CodeViewUnavailable(`The base branch could not be fetched: ${errorText(error)}`);
      }
    }
    const safe = safeRef(ref);
    if (safe === null) throw new CodeViewUnavailable(`"${ref}" is not a ref`);
    const dest = `${EXTRA_REFS}/${createHash('sha256').update(safe).digest('hex').slice(0, 20)}`;
    if (SHA.test(safe)) {
      if ((await this.revParse(boardId, `${safe}^{commit}`)) !== null) return safe;
    } else {
      const known = await this.revParse(boardId, dest);
      if (known !== null && this.now() - (this.fetchedAt.get(`${String(boardId)} ${dest}`) ?? 0) < REF_FRESH_MS) return known;
    }
    return this.exclusive(boardId, async () => {
      try {
        await this.fetch(boardId, repo, `+${safe}:${dest}`, 1);
        this.fetchedAt.set(`${String(boardId)} ${dest}`, this.now());
      } catch (error) {
        // A moved branch we could not refresh is still better than nothing only if it fetched once; otherwise give up.
        const known = await this.revParse(boardId, dest);
        if (known === null) throw new CodeViewUnavailable(`${safe} could not be fetched: ${errorText(error)}`, { cause: error });
        return known;
      }
      const sha = await this.revParse(boardId, dest);
      if (sha === null) throw new CodeViewUnavailable(`${safe} was not fetched`);
      await this.enforceCap(boardId, repo);
      return sha;
    });
  }

  /** The sha the base ref points at in the clone, or null when there is no clone yet. */
  baseSha(boardId: number): Promise<string | null> {
    return this.revParse(boardId, BASE_REF);
  }

  /** Runs a read-only git command in the board's clone and returns stdout. A non-zero exit rejects; `okCodes` are returned as output. */
  async git(boardId: number, args: readonly string[], options: { okCodes?: readonly number[]; maxBuffer?: number; signal?: AbortSignal } = {}): Promise<string> {
    try {
      const { stdout } = await run('git', [...args], {
        cwd: this.clonePath(boardId),
        env: this.env(''),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? OUTPUT_LIMIT,
        signal: options.signal,
        encoding: 'utf8',
      });
      return stdout;
    } catch (error) {
      if (isExit(error) && options.okCodes?.includes(Number(error.code)) === true) return typeof error.stdout === 'string' ? error.stdout : '';
      throw error;
    }
  }

  /** Streams a git command's stdout line by line (no output buffer to overflow). Exit status 1 counts as "no output". */
  lines(boardId: number, args: readonly string[], onLine: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...args], { cwd: this.clonePath(boardId), env: this.env(''), stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 2000) stderr += chunk.toString('utf8');
      });
      createInterface({ input: child.stdout }).on('line', onLine);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 || code === 1) resolve();
        else reject(new Error(stderr.trim().split('\n')[0] ?? `git exited with ${String(code)}`));
      });
    });
  }

  /** Deletes a board's clone (the board lost its repository, or the clone is damaged). */
  remove(boardId: number): Promise<void> {
    return this.exclusive(boardId, () => rm(this.clonePath(boardId), { recursive: true, force: true }));
  }

  private branchOf(repo: Repo): string {
    const branch = safeRef(repo.base);
    if (branch === null) throw new Error(`The base branch "${repo.base}" is not a usable ref name`);
    return branch;
  }

  private env(token: string): NodeJS.ProcessEnv {
    return {
      ...gitEnv(token, [['core.hooksPath', '/dev/null'], ['fetch.recurseSubmodules', 'false'], ['core.fsmonitor', 'false']]),
      GIT_LITERAL_PATHSPECS: '1',
    };
  }

  private exclusive<T>(boardId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(boardId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.chains.set(boardId, settled);
    void settled.then(() => {
      if (this.chains.get(boardId) === settled) this.chains.delete(boardId);
    });
    return next;
  }

  private async ensureRepo(boardId: number): Promise<void> {
    const dir = this.clonePath(boardId);
    try {
      await stat(join(dir, 'HEAD'));
      return;
    } catch {
      // Not there yet.
    }
    await mkdir(dir, { recursive: true });
    // An empty template: none of git's sample hooks are copied in.
    await run('git', ['init', '--bare', '--quiet', '--template=', dir], { env: this.env(''), timeout: GIT_TIMEOUT_MS });
  }

  private async fetch(boardId: number, repo: Repo, refspec: string, depth: number): Promise<void> {
    await this.ensureRepo(boardId);
    const token = await this.opts.host.readToken(repo);
    await run('git', ['fetch', '--quiet', `--depth=${String(depth)}`, '--no-tags', '--no-recurse-submodules', '--force', this.remote(repo), refspec], {
      cwd: this.clonePath(boardId),
      env: this.env(token),
      timeout: GIT_TIMEOUT_MS,
    });
  }

  private async revParse(boardId: number, rev: string): Promise<string | null> {
    try {
      const out = await this.git(boardId, ['rev-parse', '--verify', '--quiet', rev]);
      const sha = out.trim();
      return SHA.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /** Drops on-demand refs that went unused for a week, and shrinks a clone that is over its cap. */
  private async enforceCap(boardId: number, repo: Repo): Promise<void> {
    let pruned = false;
    const refs = await this.git(boardId, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', EXTRA_REFS]);
    for (const row of refs.split('\n')) {
      const [name, unix] = row.split(' ');
      if (name !== undefined && name !== '' && this.now() - Number(unix) * 1000 > REF_KEEP_MS) {
        await this.git(boardId, ['update-ref', '-d', name]);
        pruned = true;
      }
    }
    if (pruned) await this.gc(boardId);
    if ((await sizeOf(this.clonePath(boardId))) <= this.capBytes) return;
    // Over the cap: the on-demand refs go first, then the history is cut back.
    for (const name of (await this.git(boardId, ['for-each-ref', '--format=%(refname)', EXTRA_REFS])).split('\n').filter((n) => n !== '')) {
      await this.git(boardId, ['update-ref', '-d', name]);
    }
    await this.gc(boardId);
    if ((await sizeOf(this.clonePath(boardId))) <= this.capBytes) return;
    this.opts.warn?.(`Board ${String(boardId)}'s clone is over its cap; fetching ${String(SHRUNK_DEPTH)} commits of history only`);
    await rm(this.clonePath(boardId), { recursive: true, force: true });
    await this.fetch(boardId, repo, `+refs/heads/${this.branchOf(repo)}:${BASE_REF}`, SHRUNK_DEPTH);
    await this.gc(boardId);
    if ((await sizeOf(this.clonePath(boardId))) > this.capBytes) {
      await rm(this.clonePath(boardId), { recursive: true, force: true });
      throw new Error(`Board ${String(boardId)}'s repository does not fit in its ${String(Math.round(this.capBytes / 1024 / 1024))} MB clone cap`);
    }
  }

  private async gc(boardId: number): Promise<void> {
    await this.git(boardId, ['reflog', 'expire', '--expire=now', '--all']);
    await this.git(boardId, ['gc', '--prune=now', '--quiet']);
  }
}

const isExit = (error: unknown): error is { code: unknown; stdout?: unknown } => typeof error === 'object' && error !== null && 'code' in error;

const errorText = (error: unknown): string => (error instanceof Error ? error.message.split('\n')[0] ?? 'failed' : String(error));

/** Bytes under a folder; 0 when it doesn't exist. */
const sizeOf = async (dir: string): Promise<number> => {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await sizeOf(path) : (await stat(path)).size;
  }
  return total;
};
