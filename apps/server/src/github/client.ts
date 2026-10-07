import { App } from '@octokit/app';
import { z } from 'zod';
import type { CheckFailure, DiffSummary, Glob } from '@slop/core';
import { machine } from '@slop/core';
import type { CodeHost, CommitFiles, MergeResult, MergeState, Repo, RepoConnection } from '../codehost.js';
import { readCommitChecks } from './commit-checks.js';
import { classifyMergeState } from './merge-state.js';
import type { AppCredentialsStore } from './credentials.js';

type Octokit = Awaited<ReturnType<App['getInstallationOctokit']>>;

/** The parts of `GET /repos/{owner}/{repo}/commits/{ref}` a merged sub's size is read from. */
const commitStats = z.object({
  stats: z.object({ additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() }),
  files: z.array(z.object({ filename: z.string() })).optional(),
});

const status = (error: unknown): number | null =>
  typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status
    : null;

const isStatus = (error: unknown, ...codes: number[]) => {
  const code = status(error);
  return code !== null && codes.includes(code);
};

/**
 * slop's GitHub operations, acting as the GitHub App (`slop[bot]`) with installation tokens.
 * Every glob's branch is its ID, created by slop with an empty first commit so a draft PR can
 * be opened before any work exists.
 */
export class GitHub implements CodeHost {
  private readonly installations = new Map<string, Octokit>();
  private app: App | null = null;
  private appId: number | null = null;

  constructor(private readonly credentials: AppCredentialsStore) {}

  get configured(): boolean {
    return this.credentials.get() !== null;
  }

  private getApp(): App {
    const credentials = this.credentials.get();
    if (credentials === null) throw new Error('The GitHub App is not set up (/setup/github-app)');
    if (this.app === null || this.appId !== credentials.id) {
      this.app = new App({ appId: credentials.id, privateKey: credentials.pem });
      this.appId = credentials.id;
      this.installations.clear();
    }
    return this.app;
  }

  async connection(repo: Repo): Promise<RepoConnection> {
    const credentials = this.credentials.get();
    if (credentials === null) return { configured: false, connected: false, installUrl: null, appName: null };
    const installUrl = `https://github.com/apps/${credentials.slug}/installations/new`;
    try {
      // 404 when the app is not installed on the account, or the installation excludes the repo.
      await this.getApp().octokit.request('GET /repos/{owner}/{repo}/installation', { owner: repo.owner, repo: repo.name });
      const octokit = await this.octokit(repo);
      await octokit.request('GET /repos/{owner}/{repo}', { owner: repo.owner, repo: repo.name });
      return { configured: true, connected: true, installUrl, appName: credentials.slug };
    } catch (error) {
      if (!isStatus(error, 404)) throw error;
      this.installations.delete(`${repo.owner}/${repo.name}`);
      return { configured: true, connected: false, installUrl, appName: credentials.slug };
    }
  }

  private async octokit(repo: Repo): Promise<Octokit> {
    const key = `${repo.owner}/${repo.name}`;
    const cached = this.installations.get(key);
    if (cached !== undefined) return cached;
    const app = this.getApp();
    const { data } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', {
      owner: repo.owner,
      repo: repo.name,
    });
    const octokit = await app.getInstallationOctokit(data.id);
    this.installations.set(key, octokit);
    return octokit;
  }

  /**
   * Creates the glob's branch with an empty `<id>: start` commit and opens its draft PR with
   * labels. Idempotent: an existing branch or open PR is reused, so retries are safe.
   */
  async provision(repo: Repo, glob: Glob): Promise<{ branch: string; pr: { number: number; headSha: string } }> {
    const gh = await this.octokit(repo);
    const r = { owner: repo.owner, repo: repo.name };
    let headSha = await this.branchHead(repo, glob.id);
    if (headSha === null) {
      const { data: base } = await gh.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        ...r,
        ref: `heads/${repo.base}`,
      });
      const { data: baseCommit } = await gh.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
        ...r,
        commit_sha: base.object.sha,
      });
      const { data: start } = await gh.request('POST /repos/{owner}/{repo}/git/commits', {
        ...r,
        message: `${glob.id}: start`,
        tree: baseCommit.tree.sha,
        parents: [base.object.sha],
      });
      try {
        await gh.request('POST /repos/{owner}/{repo}/git/refs', { ...r, ref: `refs/heads/${glob.id}`, sha: start.sha });
        headSha = start.sha;
      } catch (error) {
        // A concurrent attempt created it first.
        if (!isStatus(error, 422)) throw error;
        headSha = await this.branchHead(repo, glob.id);
        if (headSha === null) throw error;
      }
    }

    const pr = await this.openDraftPr(repo, glob);
    // The start commit means there is always something to merge.
    if (pr === null) throw new Error(`GitHub refused a draft PR for ${glob.id}`);
    return { branch: glob.id, pr };
  }

  async openDraftPr(repo: Repo, glob: Glob): Promise<{ number: number; headSha: string } | null> {
    const gh = await this.octokit(repo);
    let pr = await this.openPr(repo, glob.id);
    if (pr === null) {
      try {
        const { data } = await gh.request('POST /repos/{owner}/{repo}/pulls', {
          owner: repo.owner,
          repo: repo.name,
          title: `${glob.id}: ${glob.title}`,
          head: glob.id,
          base: repo.base,
          draft: true,
          body: this.prBody(glob),
        });
        pr = { number: data.number, headSha: data.head.sha };
      } catch (error) {
        if (!isStatus(error, 422)) throw error;
        // A concurrent attempt opened it first, or "No commits between": nothing to merge yet.
        pr = await this.openPr(repo, glob.id);
        if (pr === null) return null;
      }
    }
    await this.syncLabels(repo, glob, pr.number);
    return pr;
  }

  async syncLabels(repo: Repo, glob: Glob, prNumber: number): Promise<void> {
    const gh = await this.octokit(repo);
    const r = { owner: repo.owner, repo: repo.name };
    const wanted = [`slop:${glob.type}`, ...(glob.environment === null ? [] : [`env:${glob.environment}`])];
    const { data: current } = await gh.request('GET /repos/{owner}/{repo}/issues/{issue_number}/labels', {
      ...r,
      issue_number: prNumber,
    });
    for (const label of current) {
      const name = label.name;
      if ((name.startsWith('slop:') || name.startsWith('env:')) && !wanted.includes(name)) {
        await gh.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
          ...r,
          issue_number: prNumber,
          name,
        });
      }
    }
    // Labels that don't exist yet are created by GitHub.
    await gh.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
      ...r,
      issue_number: prNumber,
      labels: wanted,
    });
  }

  async closePr(repo: Repo, prNumber: number): Promise<void> {
    const gh = await this.octokit(repo);
    try {
      await gh.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        state: 'closed',
      });
    } catch (error) {
      if (!isStatus(error, 404, 422)) throw error;
    }
  }

  async deleteBranch(repo: Repo, branch: string): Promise<void> {
    const gh = await this.octokit(repo);
    try {
      await gh.request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
        owner: repo.owner,
        repo: repo.name,
        ref: `heads/${branch}`,
      });
    } catch (error) {
      if (!isStatus(error, 404, 422)) throw error;
    }
  }

  /** Reopens the glob's closed PR, or reports that it must be provisioned again. */
  async reopenPr(repo: Repo, prNumber: number, branch: string): Promise<'reopened' | 'missing'> {
    if ((await this.branchHead(repo, branch)) === null) return 'missing';
    const gh = await this.octokit(repo);
    try {
      await gh.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        state: 'open',
      });
      return 'reopened';
    } catch (error) {
      if (isStatus(error, 422)) return 'missing';
      throw error;
    }
  }

  /** GitHub's view of whether the PR's head can merge: required checks, conflicts, up to date. */
  async mergeState(repo: Repo, prNumber: number): Promise<{ sha: string; state: MergeState }> {
    const gh = await this.octokit(repo);
    const { data } = await gh.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
    });
    let runs: { status: string; conclusion: string | null }[] = [];
    if (data.mergeable_state === 'unstable' || data.mergeable_state === 'blocked') {
      const checks = await gh.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
        owner: repo.owner,
        repo: repo.name,
        ref: data.head.sha,
        filter: 'latest',
        per_page: 100,
      });
      runs = checks.data.check_runs;
    }
    const state = classifyMergeState(data.mergeable_state, runs);
    return { sha: data.head.sha, state };
  }

  /** The latest completed check run named `name` on `sha`; only a `success` conclusion passes. */
  async completedCheckRun(repo: Repo, sha: string, name: string): Promise<{ sha: string; passed: boolean } | null> {
    const gh = await this.octokit(repo);
    const { data } = await gh.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
      owner: repo.owner,
      repo: repo.name,
      ref: sha,
      check_name: name,
      status: 'completed',
      filter: 'latest',
    });
    const latest = data.check_runs
      .filter((run) => run.status === 'completed' && run.head_sha === sha)
      .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))[0];
    return latest === undefined ? null : { sha, passed: latest.conclusion === 'success' };
  }

  async headOf(repo: Repo, ref: string): Promise<{ sha: string; subject: string } | null> {
    const gh = await this.octokit(repo);
    try {
      const { data } = await gh.request('GET /repos/{owner}/{repo}/commits/{ref}', { owner: repo.owner, repo: repo.name, ref });
      return { sha: data.sha, subject: data.commit.message.split('\n')[0] ?? '' };
    } catch (error) {
      if (isStatus(error, 404, 422)) return null;
      throw error;
    }
  }

  async commitChecks(repo: Repo, sha: string): Promise<{ state: 'passed' | 'pending' | 'failed'; failure: CheckFailure | null }> {
    const gh = await this.octokit(repo);
    return readCommitChecks((route, params) => gh.request(route, params), repo, sha);
  }

  async updateBranch(repo: Repo, prNumber: number, sha: string): Promise<'updating' | 'up_to_date' | 'conflict'> {
    const gh = await this.octokit(repo);
    const { state } = await this.mergeState(repo, prNumber);
    if (state === 'conflict') return 'conflict';
    // Only a branch that is behind has anything to take in; its head moved on otherwise.
    if (state !== 'behind') return 'up_to_date';
    try {
      await gh.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', {
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        expected_head_sha: sha,
      });
      return 'updating';
    } catch (error) {
      if (isStatus(error, 422)) return 'conflict';
      throw error;
    }
  }

  /**
   * Squash-merges the PR at exactly `sha` with the title `<id>: <title>` (`machine.squashTitle`). If the branch is
   * behind the base, slop updates it instead and the merge resumes when the new head's checks pass.
   */
  async squashMerge(repo: Repo, glob: Glob, prNumber: number, sha: string): Promise<MergeResult> {
    const gh = await this.octokit(repo);
    const r = { owner: repo.owner, repo: repo.name, pull_number: prNumber };
    const { state } = await this.mergeState(repo, prNumber);
    if (state === 'conflict') return { outcome: 'conflict' };
    if (state === 'behind') {
      try {
        await gh.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', { ...r, expected_head_sha: sha });
        return { outcome: 'updating' };
      } catch (error) {
        if (isStatus(error, 422)) return { outcome: 'conflict' };
        throw error;
      }
    }
    try {
      const { data } = await gh.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
        ...r,
        sha,
        merge_method: 'squash',
        commit_title: machine.squashTitle(glob),
        commit_message: '',
      });
      return { outcome: 'merged', sha: data.sha };
    } catch (error) {
      if (isStatus(error, 405, 409)) {
        return { outcome: 'refused', reason: error instanceof Error ? error.message : 'GitHub refused the merge' };
      }
      throw error;
    }
  }

  async markReady(repo: Repo, prNumber: number): Promise<{ wasDraft: boolean; sha: string }> {
    const gh = await this.octokit(repo);
    const { data } = await gh.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
    });
    if (!data.draft) return { wasDraft: false, sha: data.head.sha };
    // REST has no endpoint for this; GraphQL does.
    await gh.graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }', {
      id: data.node_id,
    });
    return { wasDraft: true, sha: data.head.sha };
  }

  async conflictFiles(repo: Repo, prNumber: number): Promise<string[]> {
    try {
      const gh = await this.octokit(repo);
      const { data: pr } = await gh.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
      });
      const changed = async (basehead: string) => {
        const { data } = await gh.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
          owner: repo.owner,
          repo: repo.name,
          basehead,
          per_page: 300,
        });
        return (data.files ?? []).map((f) => f.filename);
      };
      // `a...b` lists what b changed since the two diverged, so the overlap is where both sides edited.
      const onBranch = new Set(await changed(`${repo.base}...${pr.head.sha}`));
      return (await changed(`${pr.head.sha}...${repo.base}`)).filter((f) => onBranch.has(f));
    } catch {
      // Naming the files is a courtesy; the conflict is reported without them.
      return [];
    }
  }

  async commentOnce(repo: Repo, prNumber: number, marker: string, body: string): Promise<'posted' | 'exists'> {
    const gh = await this.octokit(repo);
    const r = { owner: repo.owner, repo: repo.name, issue_number: prNumber };
    // Comments come oldest first; a marker is looked for in the first thousand.
    for (let page = 1; page <= 10; page++) {
      const { data } = await gh.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...r, per_page: 100, page });
      if (data.some((c) => c.body?.includes(marker) === true)) return 'exists';
      if (data.length < 100) break;
    }
    await gh.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...r, body });
    return 'posted';
  }

  async diffSummary(repo: Repo, sha: string): Promise<DiffSummary> {
    return this.compare(repo, `${repo.base}...${sha}`);
  }

  /**
   * The commit's own `stats`, which GitHub computes from the commit's diff against its first parent: for a squash merge
   * (one parent, the convention here) or a true merge commit (its first parent is the base) alike, that is the whole
   * PR. A rebase merge lands several commits, so only the last one's lines are counted. The stats aren't subject to
   * the 300-file list limit; the file names are the response's first page of files.
   */
  async commitDiffSummary(repo: Repo, sha: string, signal?: AbortSignal): Promise<DiffSummary> {
    const gh = await this.octokit(repo);
    const { data } = await gh.request('GET /repos/{owner}/{repo}/commits/{ref}', { owner: repo.owner, repo: repo.name, ref: sha, request: { signal } });
    const commit = commitStats.parse(data);
    return {
      changedLines: commit.stats.additions + commit.stats.deletions,
      files: (commit.files ?? []).map((f) => f.filename),
    };
  }

  private async compare(repo: Repo, basehead: string, signal?: AbortSignal): Promise<DiffSummary> {
    const gh = await this.octokit(repo);
    const { data } = await gh.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
      owner: repo.owner,
      repo: repo.name,
      basehead,
      per_page: 300,
      request: { signal },
    });
    const files = data.files ?? [];
    return {
      changedLines: files.reduce((sum, f) => sum + f.additions + f.deletions, 0),
      files: files.map((f) => f.filename),
    };
  }

  async readFile(repo: Repo, ref: string, path: string, signal?: AbortSignal): Promise<string | null> {
    const gh = await this.octokit(repo);
    try {
      const { data } = await gh.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: repo.owner,
        repo: repo.name,
        path,
        ref,
        request: { signal },
      });
      if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) {
      if (isStatus(error, 404)) return null;
      throw error;
    }
  }

  async commitFiles(repo: Repo, sha: string, signal?: AbortSignal): Promise<CommitFiles> {
    const gh = await this.octokit(repo);
    const { data } = await gh.request('GET /repos/{owner}/{repo}/commits/{ref}', { owner: repo.owner, repo: repo.name, ref: sha, request: { signal } });
    const statuses = ['added', 'removed', 'modified', 'renamed'] as const;
    return {
      parent: data.parents[0]?.sha ?? null,
      files: (data.files ?? []).map((f) => ({
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: statuses.find((s) => s === f.status) ?? 'other',
      })),
    };
  }

  private async branchHead(repo: Repo, branch: string): Promise<string | null> {
    const gh = await this.octokit(repo);
    try {
      const { data } = await gh.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner: repo.owner,
        repo: repo.name,
        ref: `heads/${branch}`,
      });
      return data.object.sha;
    } catch (error) {
      if (isStatus(error, 404)) return null;
      throw error;
    }
  }

  private async openPr(repo: Repo, branch: string): Promise<{ number: number; headSha: string } | null> {
    const gh = await this.octokit(repo);
    const { data } = await gh.request('GET /repos/{owner}/{repo}/pulls', {
      owner: repo.owner,
      repo: repo.name,
      head: `${repo.owner}:${branch}`,
      state: 'open',
    });
    const [pr] = data;
    return pr === undefined ? null : { number: pr.number, headSha: pr.head.sha };
  }

  private prBody(glob: Glob): string {
    const summary = glob.summary.trim();
    return [
      summary === '' ? '_No summary yet._' : summary,
      '',
      `Slop glob **${glob.id}** (${glob.type}, ${glob.category}). Merge from the glob or here; squash merge only.`,
    ].join('\n');
  }
}
