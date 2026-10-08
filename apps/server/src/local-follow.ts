import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { HealthSink, ReportedDeploy } from '@slop/core';

/** What `scripts/dev.sh follow` writes after each poll that changed something. */
const statusSchema = z.object({
  state: z.enum(['following', 'updated', 'held']),
  at: z.string(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  repo: z.string().min(1),
  behind: z.string().optional(),
  reason: z.string().optional(),
  fix: z.string().optional(),
  subjects: z.string().optional(),
  migrations: z.string().optional(),
  snapshot: z.string().optional(),
});
export type FollowStatus = z.infer<typeof statusSchema>;

/** How long the board says that the local server was updated. */
const UPDATED_NOTICE_MS = 10 * 60_000;

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * Local development only: reads the status `scripts/dev.sh follow` keeps for the main checkout, so the board
 * says when the local server was updated to main (and what migrations ran) or why following is held, and
 * records the commit it runs as a deploy to the board's local integration environment (cards then show which
 * merged globs this server runs).
 */
export class LocalFollowWatch {
  private timer: NodeJS.Timeout | null = null;
  private recorded: string | null = null;

  constructor(
    private readonly file: string,
    private readonly environment: string,
    private readonly health: HealthSink,
    private readonly recordDeploy: (deploy: ReportedDeploy) => Promise<number[]>,
    private readonly logError: (where: string, message: string) => void,
    private readonly now: () => number = Date.now,
    private readonly read: (file: string) => Promise<string> = (file) => readFile(file, 'utf8'),
  ) {}

  async check(): Promise<void> {
    const status = await this.status();
    if (status === null) return;
    this.health.report('local', describe(status, this.now()));
    if (status.state === 'held' || this.recorded === status.sha) return;
    try {
      await this.recordDeploy({
        repo: status.repo,
        environment: this.environment,
        sha: status.sha,
        ref: null,
        succeeded: true,
        url: null,
        at: status.at,
        eventId: `local:${status.sha}`,
      });
      this.recorded = status.sha;
    } catch (error) {
      this.logError('local follow', error instanceof Error ? error.message : String(error));
    }
  }

  private async status(): Promise<FollowStatus | null> {
    let text: string;
    try {
      text = await this.read(this.file);
    } catch {
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed = statusSchema.safeParse(json);
    if (!parsed.success) {
      this.logError('local follow', `${this.file} is not a follow status`);
      return null;
    }
    return parsed.data;
  }

  start(intervalMs = 15_000): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The banner line for a follow status: a hold until it clears, an update for a few minutes, else nothing. */
export const describe = (
  status: FollowStatus,
  now: number,
): { readonly state: 'ok' } | { readonly state: 'degraded' | 'down'; readonly reason: string; readonly fix: string } => {
  const sha = status.sha.slice(0, 7);
  if (status.state === 'held') {
    const behind = Number(status.behind ?? '0');
    const lag = behind > 0 ? `${plural(behind, 'commit')} behind main` : 'not following main';
    return {
      state: 'down',
      reason: `Local slop is ${lag} (at ${sha}): ${status.reason ?? 'held'}`,
      fix: status.fix ?? 'See the follow window (scripts/dev.sh follow)',
    };
  }
  if (status.state === 'updated' && now - Date.parse(status.at) < UPDATED_NOTICE_MS) {
    const first = status.subjects?.split(';')[0] ?? '';
    const ran = status.migrations ? `; ran migration ${status.migrations.split(',').join(', ')}` : '';
    const snapshot = status.snapshot ? ` (snapshot ${status.snapshot.split('/').pop() ?? status.snapshot})` : '';
    return {
      state: 'degraded',
      reason: `Local slop updated to ${sha}${first === '' ? '' : ` (${first})`}${ran}${snapshot}`,
      fix: 'Nothing to do: this note clears by itself',
    };
  }
  return { state: 'ok' };
};
