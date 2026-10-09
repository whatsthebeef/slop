import type { DomainEvent, DomainEventType, JsonValue } from './events.js';
import { isRnd, listOf } from './matrix.js';
import { CATEGORIES, SLOP_TYPES, STATUSES } from './types.js';
import type { Category, SlopType, Status } from './types.js';

/**
 * Time tracking (spec, Time tracking and reports): hours are derived from the event log, never recorded as they happen.
 * A glob counts for a person only while it is their single active glob (across boards), it is in Doing, and it is
 * attributed to them (its implementer, else its planner). Counted intervals are clipped to 09:00–17:00 on weekdays in
 * one time zone. Everything here is pure; the zone is passed in and `Intl` (a global) does the zone arithmetic.
 */

/** The events the replay reads; the rest of the log says nothing about who works on what. */
export const TIME_EVENT_TYPES = ['GlobCreated', 'StatusChanged', 'PickedUp', 'FieldsChanged'] as const satisfies readonly DomainEventType[];
/** The only event `data` keys `deriveSegments` reads, so the store can leave the rest of each payload behind. */
export const TIME_EVENT_DATA_KEYS = ['status', 'to', 'category', 'type'] as const;

export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 17;

/** What the glob row says, for a glob whose `GlobCreated` event isn't in the log read. */
export interface GlobFacts {
  readonly planner: string;
  readonly category: Category;
  readonly type: SlopType;
}

/** A glob's facts plus where it lives, as the store reads them for a report (no whole glob). */
export interface GlobReportFacts extends GlobFacts {
  readonly id: string;
  readonly boardId: number;
}

/** A stretch of time counted for one person on one glob, in one category (`from` < `to`, ISO instants). */
export interface Segment {
  readonly person: string;
  readonly globId: string;
  readonly category: Category;
  readonly from: string;
  readonly to: string;
}

interface GlobState {
  status: Status | null;
  category: Category;
  type: SlopType;
  planner: string;
  implementer: string | null;
}

const statusOf = (value: JsonValue | undefined): Status | null => STATUSES.find((s) => s === value) ?? null;
const categoryOf = (value: JsonValue | undefined): Category | null => CATEGORIES.find((c) => c === value) ?? null;
const typeOf = (value: JsonValue | undefined): SlopType | null => SLOP_TYPES.find((t) => t === value) ?? null;
const inDoing = (status: Status | null): boolean => status !== null && listOf(status) === 'doing';

/** The `to` of a `{ from, to }` change in a `FieldsChanged` event. */
const changedTo = (value: JsonValue | undefined): JsonValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && 'to' in value ? value.to : undefined;

const attributed = (g: GlobState): string => g.implementer ?? g.planner;

/**
 * Replays `events` (oldest first, in log order, every board) into counting segments, closing open ones at `until`.
 * Only a person's own move into Doing (a `StatusChanged` with an actor), a pick-up, or creating a super straight into
 * Doing makes a glob their active glob: a glob created into Doing (a sub, an auto-started same) and system moves
 * (null actor: releases, reverts, observed merges) don't. Leaving Doing, or the glob's attribution moving to someone
 * else, clears it as the active glob of whoever had it, so an older glob never resumes by itself.
 */
export const deriveSegments = (
  events: readonly DomainEvent[],
  globs: ReadonlyMap<string, GlobFacts>,
  until: string,
): Segment[] => {
  const state = new Map<string, GlobState>();
  const active = new Map<string, string | null>();
  const open = new Map<string, { globId: string; category: Category; from: string }>();
  const segments: Segment[] = [];

  const close = (person: string, at: string) => {
    const current = open.get(person);
    if (current === undefined) return;
    open.delete(person);
    if (current.from < at) segments.push({ person, globId: current.globId, category: current.category, from: current.from, to: at });
  };
  const clearActive = (globId: string) => {
    for (const [person, id] of active) if (id === globId) active.set(person, null);
  };
  const reconcile = (at: string) => {
    for (const person of new Set([...active.keys(), ...open.keys()])) {
      const globId = active.get(person) ?? null;
      const g = globId === null ? undefined : state.get(globId);
      const want = globId !== null && g !== undefined && inDoing(g.status) && attributed(g) === person ? { globId, category: g.category } : null;
      const current = open.get(person);
      if (current?.globId === want?.globId && current?.category === want?.category) continue;
      close(person, at);
      if (want !== null) open.set(person, { ...want, from: at });
    }
  };

  for (const e of events) {
    if (e.at >= until) break;
    let g = state.get(e.globId);
    if (g === undefined) {
      const facts = globs.get(e.globId);
      const planner = e.type === 'GlobCreated' ? e.actor : (facts?.planner ?? null);
      const category = categoryOf(e.type === 'GlobCreated' ? e.data.category : undefined) ?? facts?.category;
      const type = typeOf(e.type === 'GlobCreated' ? e.data.type : undefined) ?? facts?.type;
      // A glob with no planner known (no creation event and no row) can't be attributed to anyone.
      if (planner === null || category === undefined || type === undefined) continue;
      g = { status: null, category, type, planner, implementer: null };
      state.set(e.globId, g);
    }
    const before = attributed(g);
    const wasDoing = inDoing(g.status);
    let activate: string | null = null;

    switch (e.type) {
      case 'GlobCreated':
        g.status = statusOf(e.data.status) ?? g.status;
        // A super's creator is its implementer from the start, and creating one into Doing is picking it up.
        if (g.type === 'super' && e.actor !== null) {
          g.implementer = e.actor;
          if (inDoing(g.status)) activate = e.actor;
        }
        break;
      case 'StatusChanged': {
        g.status = statusOf(e.data.to) ?? g.status;
        // Every move to implementing (re-trigger, start again, a released sub) and a same's start again to planning
        // clears the implementer.
        if (g.status === 'implementing' || g.status === 'planning') g.implementer = null;
        if (!wasDoing && inDoing(g.status) && e.actor !== null) activate = e.actor;
        break;
      }
      case 'PickedUp':
        if (e.actor !== null) {
          g.implementer = e.actor;
          activate = e.actor;
        }
        // A pick-up always leaves the glob in Doing (from planning or failed it moves to in_progress first).
        if (!inDoing(g.status)) g.status = 'in_progress';
        break;
      case 'FieldsChanged':
        g.category = categoryOf(changedTo(e.data.category)) ?? g.category;
        g.type = typeOf(changedTo(e.data.type)) ?? g.type;
        break;
      default:
        break;
    }

    if (wasDoing && !inDoing(g.status)) clearActive(e.globId);
    const after = attributed(g);
    if (after !== before && active.get(before) === e.globId) active.set(before, null);
    if (activate !== null) active.set(activate, e.globId);
    reconcile(e.at);
  }

  for (const person of [...open.keys()]) close(person, until);
  return segments;
};

// ---- Working hours in a time zone ----

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (zone: string): Intl.DateTimeFormat => {
  let f = formatters.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  return f;
};

/** Whether `zone` is an IANA time zone this runtime knows. */
export const isValidTimeZone = (zone: string): boolean => {
  if (zone.trim() === '') return false;
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
};

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const localParts = (ms: number, zone: string): LocalParts => {
  const parts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatterFor(zone).formatToParts(new Date(ms))) {
    if (p.type === 'year' || p.type === 'month' || p.type === 'day' || p.type === 'hour' || p.type === 'minute' || p.type === 'second') {
      parts[p.type] = Number(p.value);
    }
  }
  return parts;
};

/** How far the zone's wall clock is ahead of UTC at instant `ms`. */
const offsetAt = (ms: number, zone: string): number => {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = localParts(whole, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
};

/**
 * The instant at which the zone's wall clock reads `year-month-day hour:00`. Two passes find the offset in force then,
 * so a DST change on another day doesn't shift it; a time inside a DST gap resolves deterministically.
 */
const zonedToUtc = (year: number, month: number, day: number, hour: number, zone: string): number => {
  const guess = Date.UTC(year, month - 1, day, hour);
  const first = offsetAt(guess, zone);
  const second = offsetAt(guess - first, zone);
  return first === second ? guess - first : guess - second;
};

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/**
 * The working time in `[from, to)`, per local date (`YYYY-MM-DD` in `zone`): 09:00–17:00 on weekdays, holidays ignored.
 * Each local day's window is converted on its own, so DST changes between days are handled. Days with none are left out.
 */
export const workingTime = (from: string, to: string, zone: string): { date: string; ms: number }[] => {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!(start < end)) return [];
  const first = localParts(start, zone);
  const last = localParts(end, zone);
  const lastDay = Date.UTC(last.year, last.month - 1, last.day);
  const out: { date: string; ms: number }[] = [];
  for (let day = Date.UTC(first.year, first.month - 1, first.day); day <= lastDay; day += 86_400_000) {
    const d = new Date(day);
    const weekday = d.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    const windowStart = Math.max(start, zonedToUtc(y, m, dd, WORK_START_HOUR, zone));
    const windowEnd = Math.min(end, zonedToUtc(y, m, dd, WORK_END_HOUR, zone));
    if (windowStart < windowEnd) out.push({ date: `${pad(y, 4)}-${pad(m)}-${pad(dd)}`, ms: windowEnd - windowStart });
  }
  return out;
};

// ---- Periods ----

/** A report period: a month (`YYYY-MM`) or a year (`YYYY`), in the work time zone. */
export type Period =
  | { readonly kind: 'month'; readonly key: string; readonly year: number; readonly month: number }
  | { readonly kind: 'year'; readonly key: string; readonly year: number };

const monthPeriod = (year: number, month: number): Period => ({ kind: 'month', key: `${pad(year, 4)}-${pad(month)}`, year, month });
const yearPeriod = (year: number): Period => ({ kind: 'year', key: pad(year, 4), year });

/** `2026-10` or `2026` (years 2000–2100), else null. */
export const parsePeriod = (text: string): Period | null => {
  const match = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/.exec(text.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  if (year < 2000 || year > 2100) return null;
  return match[2] === undefined ? yearPeriod(year) : monthPeriod(year, Number(match[2]));
};

/** The period's start and end (exclusive) as ISO instants: local midnights in `zone`. */
export const periodBounds = (period: Period, zone: string): { from: string; to: string } => {
  const from =
    period.kind === 'month' ? zonedToUtc(period.year, period.month, 1, 0, zone) : zonedToUtc(period.year, 1, 1, 0, zone);
  const to =
    period.kind === 'month'
      ? period.month === 12
        ? zonedToUtc(period.year + 1, 1, 1, 0, zone)
        : zonedToUtc(period.year, period.month + 1, 1, 0, zone)
      : zonedToUtc(period.year + 1, 1, 1, 0, zone);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
};

export const currentYear = (now: string, zone: string): Period => yearPeriod(localParts(Date.parse(now), zone).year);
export const previousYear = (now: string, zone: string): Period => yearPeriod(localParts(Date.parse(now), zone).year - 1);
export const previousMonth = (now: string, zone: string): Period => {
  const { year, month } = localParts(Date.parse(now), zone);
  return month === 1 ? monthPeriod(year - 1, 12) : monthPeriod(year, month - 1);
};

/**
 * The periods the board offers to download, newest first: the current month and the `months` before it, then the
 * current and previous year (in `zone`).
 */
export const recentPeriods = (now: string, zone: string, months = 12): Period[] => {
  const { year, month } = localParts(Date.parse(now), zone);
  const out: Period[] = [];
  for (let i = 0; i <= months; i++) {
    const index = year * 12 + (month - 1) - i;
    out.push(monthPeriod(Math.floor(index / 12), (index % 12) + 1));
  }
  return [...out, yearPeriod(year), yearPeriod(year - 1)];
};

/** Whether the period has begun by `now` (a report of the future is refused). */
export const hasStarted = (period: Period, now: string, zone: string): boolean => periodBounds(period, zone).from <= now;

// ---- Reports ----

/** One developer's hours in a period, unrounded (milliseconds). */
export interface ReportRow {
  readonly developer: string;
  readonly period: string;
  readonly rndMs: number;
  readonly maintenanceMs: number;
}

/** Each developer's RnD (features) and maintenance (tasks, bugs) hours in `period`, by local date; zero-hour developers left out. */
export const reportRows = (segments: readonly Segment[], period: Period, zone: string): ReportRow[] => {
  const bounds = periodBounds(period, zone);
  const prefix = `${period.key}-`;
  const totals = new Map<string, { rnd: number; maintenance: number }>();
  for (const s of segments) {
    const from = s.from > bounds.from ? s.from : bounds.from;
    const to = s.to < bounds.to ? s.to : bounds.to;
    if (from >= to) continue;
    const ms = workingTime(from, to, zone)
      .filter((d) => d.date.startsWith(prefix))
      .reduce((sum, d) => sum + d.ms, 0);
    if (ms === 0) continue;
    const t = totals.get(s.person) ?? { rnd: 0, maintenance: 0 };
    if (isRnd(s.category)) t.rnd += ms;
    else t.maintenance += ms;
    totals.set(s.person, t);
  }
  return [...totals]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([developer, t]) => ({ developer, period: period.key, rndMs: t.rnd, maintenanceMs: t.maintenance }));
};

export const REPORT_CSV_HEADER = ['developer', 'period', 'RnD hours', 'maintenance hours', '% RnD'] as const;

const HOUR_MS = 3_600_000;

/** RFC 4180 quoting, with a leading `'` on a value a spreadsheet would read as a formula (OWASP: `= + - @`, tab, CR). */
const csvField = (value: string): string => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** Hours to 2 decimals; % RnD to 1 decimal from the unrounded totals. CRLF line ends; a header-only CSV when empty. */
export const reportCsv = (rows: readonly ReportRow[]): string =>
  [
    REPORT_CSV_HEADER,
    ...rows.map((r) => [
      r.developer,
      r.period,
      (r.rndMs / HOUR_MS).toFixed(2),
      (r.maintenanceMs / HOUR_MS).toFixed(2),
      ((r.rndMs / (r.rndMs + r.maintenanceMs)) * 100).toFixed(1),
    ]),
  ]
    .map((fields) => fields.map(csvField).join(',') + '\r\n')
    .join('');
