import { readFile } from 'node:fs/promises';
import { classifyRoutineFailure } from '@slop/core';
import type { HealthSink, RoutineDirectory } from '@slop/core';
import { z } from 'zod';
import type { SecretStore } from './secrets.js';

const secretSchema = z.object({ url: z.url(), token: z.string().min(1) });
const routinesSchema = z.record(z.string(), secretSchema);

export interface RoutineSecret {
  readonly url: string;
  readonly token: string;
}

/** What the server needs from the routines' secrets: whether a developer has one, and its URL and token. */
export interface RoutineSource extends RoutineDirectory {
  secretFor(email: string, boardId?: number): Promise<RoutineSecret | null>;
}

/**
 * Each developer's routine fire URL and token. Locally a gitignored file keyed by email
 * (`.routines.json`); in production Secrets Manager at `slop/routines/<email>`. A routine's cloud
 * environment has a fixed set of repositories, so a developer can add one per board under
 * `<email>#<boardId>` (Secrets Manager: `slop/routines/<email>/<boardId>`, since names can't hold `#`); a board without its own entry uses the developer's default.
 */
export class FileRoutines implements RoutineSource {
  constructor(private readonly file: string) {}

  private async all(): Promise<Record<string, RoutineSecret>> {
    try {
      const parsed = routinesSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  async hasRoutine(email: string, boardId: number): Promise<boolean> {
    return (await this.secretFor(email, boardId)) !== null;
  }

  async secretFor(email: string, boardId?: number): Promise<RoutineSecret | null> {
    const all = await this.all();
    const key = email.toLowerCase();
    return (boardId === undefined ? undefined : all[`${key}#${String(boardId)}`]) ?? all[key] ?? null;
  }
}

/**
 * Production's routines, in Secrets Manager at `<prefix>routines/<email>/<boardId>` (a board's own) and
 * `<prefix>routines/<email>/default`, each `{url, token}` JSON. Reads are cached for a short TTL (misses too),
 * so a newly set routine is picked up without a restart.
 */
export class SecretRoutines implements RoutineSource {
  private readonly cache = new Map<string, { readonly at: number; readonly secret: RoutineSecret | null }>();

  constructor(
    private readonly store: SecretStore,
    private readonly prefix: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private name(email: string, board: number | 'default'): string {
    return `${this.prefix}${email.toLowerCase()}/${String(board)}`;
  }

  private async read(name: string): Promise<RoutineSecret | null> {
    const hit = this.cache.get(name);
    if (hit !== undefined && this.now() - hit.at < this.ttlMs) return hit.secret;
    const raw = await this.store.get(name);
    let secret: RoutineSecret | null = null;
    if (raw !== null) {
      try {
        const parsed = secretSchema.safeParse(JSON.parse(raw));
        secret = parsed.success ? parsed.data : null;
      } catch {
        secret = null;
      }
    }
    this.cache.set(name, { at: this.now(), secret });
    return secret;
  }

  async hasRoutine(email: string, boardId: number): Promise<boolean> {
    return (await this.secretFor(email, boardId)) !== null;
  }

  async secretFor(email: string, boardId?: number): Promise<RoutineSecret | null> {
    return (boardId === undefined ? null : await this.read(this.name(email, boardId))) ?? (await this.read(this.name(email, 'default')));
  }

  /** Stores a developer's routine for a board, or their default when `boardId` is omitted. */
  async set(email: string, secret: RoutineSecret, boardId?: number): Promise<void> {
    const name = this.name(email, boardId ?? 'default');
    await this.store.put(name, JSON.stringify(secretSchema.parse(secret)));
    this.cache.delete(name);
  }
}

export type FireResult =
  | { readonly outcome: 'fired'; readonly sessionId: string | null; readonly sessionUrl: string | null }
  | { readonly outcome: 'retry'; readonly reason: string }
  | { readonly outcome: 'failed'; readonly reason: string };

const fireResponse = z.object({
  claude_code_session_id: z.string().optional(),
  claude_code_session_url: z.string().optional(),
});

/** Fires a routine through its API trigger with this run's instructions as the text. */
export const fireRoutine = async (secret: RoutineSecret, text: string, health: HealthSink | null = null): Promise<FireResult> => {
  const response = await fetch(secret.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret.token}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    health?.report('routines', { state: 'ok' });
    const parsed = fireResponse.safeParse(body);
    return {
      outcome: 'fired',
      sessionId: parsed.success ? (parsed.data.claude_code_session_id ?? null) : null,
      sessionUrl: parsed.success ? (parsed.data.claude_code_session_url ?? null) : null,
    };
  }
  const rejected = classifyRoutineFailure(response.status);
  if (rejected !== null) health?.report('routines', rejected);
  const message = `Routine fire failed (${String(response.status)})`;
  // Rate limits and server errors are retried with backoff; anything else needs a person.
  return response.status === 429 || response.status >= 500
    ? { outcome: 'retry', reason: message }
    : { outcome: 'failed', reason: message };
};

/** The text a routine run receives: which glob, which run, which repository, and how to start. */
export const runInstructions = (
  glob: { id: string; title: string },
  runId: string,
  repo: string | null,
  /** The glob's PR is already ready for review (a retried auto-fix): the run watches it instead of doing the work again. */
  prReady = false,
  /** Slop's own retry of a watcher that gave up: the failed check (name and first lines) it must fix. */
  failureSummary: string | null = null,
): string =>
  [
    `Slop glob ${glob.id}: ${glob.title}`,
    `Run ID: ${runId}`,
    ...(repo === null
      ? []
      : [
          `Repository: ${repo}. Work in that repository's checkout. If this session doesn't have it, or can't push to it, call slop's report_failure with the run ID saying so (the routine's environment needs ${repo} and the Claude GitHub App installed on it); don't work in another repository.`,
        ]),
    '',
    `Work on the glob's branch, ${glob.id}, which already exists on origin with an open ${prReady ? 'PR' : 'draft PR'}: run \`git fetch origin ${glob.id} && git checkout -B ${glob.id} origin/${glob.id}\` first. Push only to ${glob.id} (\`git push origin ${glob.id}\`); never create or push a claude/ branch, and never open a new PR.`,
    '',
    ...(prReady
      ? [
          `The PR is already ready for review and its auto-fix ended without fixing it. Don't run the phases or call mark_ready: read .claude/agents/orchestrator.md and follow its "Auto-fix (watching the PR)" section for glob ${glob.id} with run ID ${runId}.`,
          ...(failureSummary === null ? [] : ['This is slop retrying it automatically, once. The check that failed:', failureSummary]),
          "Start by calling slop's get_glob for the glob, passing the run ID: its headChecks say what failed on the PR's head.",
          'If you cannot fix it, call report_failure with the run ID.',
        ]
      : [
          `Run /run-glob ${glob.id} --run ${runId}. If that command is not available, read .claude/agents/orchestrator.md and follow it for glob ${glob.id} in unattended mode with run ID ${runId}.`,
          "Start by calling slop's get_glob and get_context for the glob, passing the run ID.",
          `When the work is pushed, call slop's mark_ready for ${glob.id} with the run ID (do not use gh). If you cannot finish, call report_failure with the run ID.`,
        ]),
  ].join('\n');

/**
 * The text of an investigate-only run: the glob is still in Planning, so there is no branch or PR. The run does the
 * orchestrator's Phases 1–2 on the base branch, pushes the investigation and stops.
 */
export const investigateInstructions = (
  glob: { id: string; title: string },
  runId: string,
  repo: string | null,
  baseBranch: string | null,
): string =>
  [
    `Slop glob ${glob.id}: ${glob.title}`,
    `Run ID: ${runId}`,
    ...(repo === null
      ? []
      : [
          `Repository: ${repo}. Work in that repository's checkout. If this session doesn't have it, call slop's report_failure with the run ID saying so (the routine's environment needs ${repo} and the Claude GitHub App installed on it); don't work in another repository.`,
        ]),
    '',
    `This is an INVESTIGATE-ONLY run. Glob ${glob.id} is still in Planning: it has no branch and no PR yet. Stay on ${baseBranch ?? "the repository's base branch"} (run \`git fetch origin${baseBranch === null ? '' : ` ${baseBranch}`}\` first); do not create or push any branch, commit anything or open a PR, and do not call mark_ready.`,
    `Read .claude/agents/orchestrator.md and follow its "Investigate-only runs" section for glob ${glob.id} in unattended mode with run ID ${runId}: Phases 1–2 only, then push the investigation with put_artifact (kind investigation, with the run ID).`,
    "Start by calling slop's get_glob and get_context for the glob, passing the run ID.",
    'If you cannot finish, call report_failure with the run ID.',
  ].join('\n');

/**
 * The text of a conflict-resolving run: the glob's PR conflicts with the base branch. The run merges the base in on the
 * glob's branch, resolves what is additive, checks and pushes; a real clash of behaviour goes back to a person.
 */
export const conflictInstructions = (
  glob: { id: string; title: string },
  runId: string,
  repo: string | null,
  baseBranch: string | null,
  conflict: { base: string; files: readonly string[] } | null,
): string => {
  const base = conflict?.base ?? baseBranch ?? 'the base branch';
  return [
    `Slop glob ${glob.id}: ${glob.title}`,
    `Run ID: ${runId}`,
    ...(repo === null
      ? []
      : [
          `Repository: ${repo}. Work in that repository's checkout. If this session doesn't have it, or can't push to it, call slop's report_failure with the run ID saying so (the routine's environment needs ${repo} and the Claude GitHub App installed on it); don't work in another repository.`,
        ]),
    '',
    `This is a RESOLVE-CONFLICT run. The open PR of ${glob.id} conflicts with ${base}${conflict === null || conflict.files.length === 0 ? '' : ` (files changed on both sides: ${conflict.files.join(', ')})`}. Don't run the phases, don't change the glob's scope and don't call mark_ready.`,
    `Run \`git fetch origin ${glob.id} && git checkout -B ${glob.id} origin/${glob.id}\`, then merge: \`git fetch origin ${base} && git merge origin/${base}\` (never rebase or reset the branch). Push only to ${glob.id} (\`git push origin ${glob.id}\`); never create or push a claude/ branch, and never open a new PR.`,
    `Resolve the conflicts as .claude/agents/orchestrator.md's "Merge conflicts when merging the base branch" says: keep both sides of additive conflicts, and renumber migrations the way it describes. Then run the board's fast checks (type check, lint, tests; install dependencies first, see "Routine runs") on the merged result and fix what the merge broke.`,
    `If both sides changed the same logic differently, run \`git merge --abort\` and call slop's report_failure with the run ID, naming the files and the decision a person has to make; don't guess. Otherwise commit the merge as \`${glob.id}: Merge ${base}\` with the Slop-Run: ${runId} trailer.`,
    `Before pushing, call slop's get_glob with the run ID and stop without pushing if your run is no longer current, a human implementer is recorded or the glob is merged. Push, then follow orchestrator.md's "Auto-fix (watching the PR)" section: subscribe to the PR's activity and fix failed checks of this glob.`,
    "Start by calling slop's get_glob for the glob, passing the run ID. If you cannot finish, call report_failure with the run ID.",
  ].join('\n');
};
