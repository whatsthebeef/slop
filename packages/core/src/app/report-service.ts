import { forbidden, invalidInput, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { TIME_EVENT_DATA_KEYS, TIME_EVENT_TYPES, deriveSegments, hasStarted, parsePeriod, periodBounds, reportCsv, reportRows } from '../domain/time-tracking.js';
import type { GlobFacts, Period } from '../domain/time-tracking.js';
import type { Member } from '../domain/types.js';
import type { Clock, Store, Tx } from '../ports.js';

/** What a board's "Time and reports" section shows: the time zone to every member of the board, downloads to its admins. */
export interface ReportsOverview {
  readonly timeZone: string;
  readonly canDownload: boolean;
}

/** One board's report for one period, computed when asked for. */
export interface Report {
  readonly boardId: number;
  readonly period: string;
  readonly kind: Period['kind'];
  readonly timeZone: string;
  /** When it was computed: a period still running counts up to here. */
  readonly computedAt: string;
  readonly csv: string;
}

/** Who may download a board's reports: the one place the rule lives (spec, Time tracking and reports, access). */
const canDownloadReports = (member: Member): boolean => member.role === 'admin';

/**
 * Monthly and yearly % RnD reports per board (spec, Time tracking and reports), computed on demand from the event log each
 * time one is downloaded: nothing is stored. The replay runs over every board's events, because a person has one active
 * glob across all boards, but a board's report only counts time on that board's globs. A board's admins download its
 * reports; any member of it sees the time zone.
 */
export class ReportService {
  constructor(private readonly deps: { store: Store; clock: Clock; timeZone: string }) {}

  /** The caller's membership of `boardId`, when they are an active user and a member of it. */
  private async member(tx: Tx, boardId: number, email: string): Promise<Member | null> {
    const user = await tx.getUser(email);
    if (user === null || !user.active) return null;
    return tx.getMember(boardId, email);
  }

  async overview(email: string, boardId: number): Promise<Result<ReportsOverview>> {
    return this.deps.store.transaction(async (tx) => {
      const member = await this.member(tx, boardId, email);
      if (member === null) return forbidden('Only board members can see reports');
      return ok({ timeZone: this.deps.timeZone, canDownload: canDownloadReports(member) });
    });
  }

  /**
   * Board `boardId`'s report for `periodText` (`2026-10` or `2026`), from the event log up to the period's end, or up to
   * now for the running period. A period that hasn't started is refused.
   */
  async report(email: string, boardId: number, periodText: string): Promise<Result<Report>> {
    return this.deps.store.transaction(async (tx) => {
      // Access first, so a caller who can't download gets the same answer whatever period they ask for.
      const member = await this.member(tx, boardId, email);
      if (member === null || !canDownloadReports(member)) return forbidden('Only board admins can download reports');
      const period = parsePeriod(periodText);
      if (period === null) return invalidInput('A period is YYYY-MM or YYYY');
      const now = this.deps.clock.now();
      const zone = this.deps.timeZone;
      if (!hasStarted(period, now, zone)) return invalidInput(`${period.key} hasn't started yet`);
      const bounds = periodBounds(period, zone);
      const until = bounds.to < now ? bounds.to : now;
      const events = await tx.listEventsUntil(until, TIME_EVENT_TYPES, TIME_EVENT_DATA_KEYS);
      const globs = await tx.globFacts([...new Set(events.map((e) => e.globId))]);
      const facts = new Map<string, GlobFacts>(globs.map((g) => [g.id, g]));
      // Every board's globs drive who is active when; only this board's (still existing) globs count toward its report.
      const onBoard = new Set(globs.filter((g) => g.boardId === boardId).map((g) => g.id));
      const segments = deriveSegments(events, facts, until).filter((s) => onBoard.has(s.globId));
      const rows = reportRows(segments, period, zone);
      return ok({ boardId, period: period.key, kind: period.kind, timeZone: zone, computedAt: now, csv: reportCsv(rows) });
    });
  }
}
