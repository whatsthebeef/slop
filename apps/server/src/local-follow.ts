import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { NotificationSink, RaisedNotification, ReportedDeploy } from '@slop/core';

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

export const LOCAL_FOLLOW_SOURCE = 'local-follow';

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * Local development only: reads the status `scripts/dev.sh follow` keeps for the main checkout, so the board
 * notifications say when the local server was updated to main (and what migrations ran) or why following is held, and
 * records the commit it runs as a deploy to the board's local integration environment (cards then show which
 * merged globs this server runs).
 */
export class LocalFollowWatch {
  private timer: NodeJS.Timeout | null = null;
  private recorded: string | null = null;
  /** The last unreadable status logged, so a bad file is logged once rather than every check. */
  private logged: string | null = null;

  constructor(
    private readonly file: string,
    private readonly environment: string,
    private readonly notifications: NotificationSink,
    private readonly recordDeploy: (deploy: ReportedDeploy) => Promise<number[]>,
    private readonly logError: (where: string, message: string) => void,
    private readonly now: () => number = Date.now,
    private readonly read: (file: string) => Promise<string> = (file) => readFile(file, 'utf8'),
  ) {}

  async check(): Promise<void> {
    const status = await this.status();
    if (status === null) return;
    try {
      const raised = describe(status, this.now());
      if (raised === null) await this.notifications.clear(null, LOCAL_FOLLOW_SOURCE);
      else await this.notifications.raise(raised);
    } catch (error) {
      this.logError('local follow', error instanceof Error ? error.message : String(error));
    }
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
      if (this.logged !== text) this.logError('local follow', `${this.file} is not a follow status`);
      this.logged = text;
      return null;
    }
    this.logged = null;
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

/**
 * The board notification for a follow status: a warning for a hold until follow carries on, info for an update
 * (cleared after a few minutes), else null. Global: the local server is one server for every board.
 */
export const describe = (status: FollowStatus, now: number): RaisedNotification | null => {
  const sha = status.sha.slice(0, 7);
  if (status.state === 'held') {
    const behind = Number(status.behind ?? '0');
    const lag = behind > 0 ? `${plural(behind, 'commit')} behind main` : 'not following main';
    return {
      boardId: null,
      source: LOCAL_FOLLOW_SOURCE,
      severity: 'warning',
      title: `Local slop is ${lag} (at ${sha})`,
      detail: `${status.reason ?? 'Following is held'}. ${status.fix ?? 'See the follow window (scripts/dev.sh follow)'}`,
      clears: { kind: 'condition' },
    };
  }
  const shownUntil = Date.parse(status.at) + UPDATED_NOTICE_MS;
  if (status.state === 'updated' && now < shownUntil) {
    const first = status.subjects?.split(';')[0] ?? '';
    const ran = status.migrations ? `; ran migration ${status.migrations.split(',').join(', ')}` : '';
    const snapshot = status.snapshot ? ` (snapshot ${status.snapshot.split('/').pop() ?? status.snapshot})` : '';
    return {
      boardId: null,
      source: LOCAL_FOLLOW_SOURCE,
      severity: 'info',
      title: `Local slop updated to ${sha}${first === '' ? '' : ` (${first})`}${ran}${snapshot}`,
      detail: 'Nothing to do: this note clears by itself.',
      clears: { kind: 'until', at: new Date(shownUntil).toISOString() },
    };
  }
  return null;
};
