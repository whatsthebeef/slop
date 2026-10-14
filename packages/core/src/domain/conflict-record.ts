import type { DomainEvent } from './events.js';

/** What the resolution of a conflict was: both sides added different things, a real clash, or not known. */
export const CONFLICT_KINDS = ['additive', 'real', 'unknown'] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

/** Who resolved it: the glob's conflict-fix run, or a person (a merge commit made by hand). */
export type ConflictResolvedBy = 'run' | 'human';

/** The event types a conflict record is read from. */
export const CONFLICT_EVENT_TYPES = ['ConflictFlagged', 'ConflictCleared', 'WorkstreamsRecorded'] as const;

/**
 * One file of one conflict a glob got. Derived from the events, never stored: `resolvedAt`, `by` and `kind` are null
 * while the conflict is open, and `by` and `kind` are null for a `ConflictCleared` written before they were recorded.
 */
export interface FileConflict {
  readonly path: string;
  /** The glob that got the conflict. */
  readonly globId: string;
  /** The glob whose merge caused it; null when not known. */
  readonly since: string | null;
  readonly base: string;
  readonly flaggedAt: string;
  readonly resolvedAt: string | null;
  readonly by: ConflictResolvedBy | null;
  readonly kind: ConflictKind | null;
  /** Set for a conflict met when a workstream was integrated onto the glob's branch: the workstream's name. */
  readonly workstream?: string;
}

const stringOf = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const stringsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const kindOf = (v: unknown): ConflictKind | null =>
  (CONFLICT_KINDS as readonly unknown[]).includes(v) ? (v as ConflictKind) : null;
const byOf = (v: unknown): ConflictResolvedBy | null => (v === 'run' || v === 'human' ? v : null);

/**
 * Per-file conflict rows from the board's events. A `ConflictFlagged` opens one row per file; the next `ConflictCleared`
 * of the same glob closes the rows it opened (those named in its `files`, or all of them when an old event names none).
 * Rows come back oldest first.
 */
export const conflictRecords = (events: readonly DomainEvent[]): FileConflict[] => {
  return [...globConflictRecords(events), ...workstreamConflictRecords(events)].sort((a, b) => a.flaggedAt.localeCompare(b.flaggedAt));
};

const globConflictRecords = (events: readonly DomainEvent[]): FileConflict[] => {
  const rows: FileConflict[] = [];
  const open = new Map<string, number[]>();
  const ordered = events
    .filter((e) => e.type === 'ConflictFlagged' || e.type === 'ConflictCleared')
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at.localeCompare(b.e.at) || a.i - b.i);
  for (const { e } of ordered) {
    if (e.type === 'ConflictFlagged') {
      const base = stringOf(e.data['base']) ?? '';
      const since = stringOf(e.data['since']);
      const indexes = open.get(e.globId) ?? [];
      for (const path of new Set(stringsOf(e.data['files']))) {
        // A glob keeps its first conflict: a second flag for a file already open adds nothing.
        if (indexes.some((i) => rows[i]?.path === path)) continue;
        indexes.push(rows.length);
        rows.push({
          path,
          globId: e.globId,
          since,
          base,
          flaggedAt: e.at,
          resolvedAt: null,
          by: null,
          kind: null,
        });
      }
      open.set(e.globId, indexes);
    } else {
      const named = new Set(stringsOf(e.data['files']));
      const by = byOf(e.data['by']);
      const kind = kindOf(e.data['kind']);
      const keep: number[] = [];
      for (const i of open.get(e.globId) ?? []) {
        const row = rows[i];
        if (row === undefined) continue;
        if (named.size > 0 && !named.has(row.path)) {
          keep.push(i);
          continue;
        }
        rows[i] = { ...row, resolvedAt: e.at, by, kind };
      }
      open.set(e.globId, keep);
    }
  }
  return rows;
};

/**
 * Integration conflicts between workstreams, as rows in the same lane as conflicts between globs. Each glob's latest
 * `WorkstreamsRecorded` event says which files each workstream conflicted on when it was integrated; one row per workstream
 * and file, flagged and resolved when the block was recorded (the run resolved it, how is not known). Oldest first.
 */
export const workstreamConflictRecords = (events: readonly DomainEvent[]): FileConflict[] => {
  const latest = new Map<string, DomainEvent>();
  for (const e of events) {
    if (e.type !== 'WorkstreamsRecorded') continue;
    const prev = latest.get(e.globId);
    if (prev === undefined || e.at >= prev.at) latest.set(e.globId, e);
  }
  const rows: FileConflict[] = [];
  for (const e of latest.values()) {
    const list = Array.isArray(e.data['workstreams']) ? (e.data['workstreams'] as unknown[]) : [];
    for (const w of list) {
      if (typeof w !== 'object' || w === null) continue;
      const name = stringOf((w as Record<string, unknown>)['name']);
      if (name === null) continue;
      for (const path of new Set(stringsOf((w as Record<string, unknown>)['conflicts']))) {
        rows.push({ path, globId: e.globId, since: null, base: '', flaggedAt: e.at, resolvedAt: e.at, by: 'run', kind: null, workstream: name });
      }
    }
  }
  return rows.sort((a, b) => a.flaggedAt.localeCompare(b.flaggedAt));
};
