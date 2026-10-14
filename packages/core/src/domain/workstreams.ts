/**
 * The workstreams block of the implementation record (kind `implementation_plan`). A fanned-out run's `## Workstreams`
 * section ends with one fenced ```` ```workstreams ```` block holding a JSON object that slop validates, as it does the
 * investigation block. A malformed block is kept as text and reported with a note, never rejected. Pure.
 */
import type { JsonValue } from './events.js';

export const WORKSTREAM_STATES = ['not_started', 'running', 'done', 'waiting_decision', 'failed', 'skipped'] as const;
export type WorkstreamState = (typeof WORKSTREAM_STATES)[number];

export interface WorkstreamRecord {
  readonly name: string;
  readonly goal: string;
  /** The files the investigator expected the workstream to change. */
  readonly predictedFiles: readonly string[];
  /** The files it changed (empty until it is integrated). */
  readonly actualFiles: readonly string[];
  /** Names of the workstreams it builds on. */
  readonly needs: readonly string[];
  readonly state: WorkstreamState;
  /** Implementer runs spent on it (a retry makes 2). */
  readonly attempts: number;
  /** Files that conflicted when it was integrated onto the glob's branch. */
  readonly conflicts: readonly string[];
  readonly durationMinutes: number | null;
}

export interface WorkstreamsBlock {
  readonly fannedOut: boolean;
  /** The most workstreams that ran at the same time. */
  readonly maxParallel: number;
  readonly workstreams: readonly WorkstreamRecord[];
}

export type WorkstreamsParse =
  /** The record has no `## Workstreams` section and no block: a small glob, nothing to say. */
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly block: WorkstreamsBlock }
  | { readonly kind: 'invalid'; readonly errors: readonly string[] };

const FENCE = /^```workstreams[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
const HEADING = /^##[ \t]+Workstreams\b/m;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The text of the last `workstreams` fence in the record, or null when there is none. */
export const workstreamsBlockText = (content: string): string | null => [...content.matchAll(FENCE)].at(-1)?.[1] ?? null;

/** Names on a `needs` cycle (each is reachable from itself), in the order given. */
const cyclic = (items: readonly { readonly name: string; readonly needs: readonly string[] }[]): string[] => {
  const needs = new Map(items.map((w) => [w.name, w.needs]));
  const onCycle = (start: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(needs.get(start) ?? [])];
    for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
      if (n === start) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(needs.get(n) ?? []));
    }
    return false;
  };
  return items.map((w) => w.name).filter(onCycle);
};

/** Reads and validates the record's workstreams block; every problem found is listed. */
export const parseWorkstreams = (content: string): WorkstreamsParse => {
  const text = workstreamsBlockText(content);
  if (text === null) {
    if (!HEADING.test(content)) return { kind: 'none' };
    return { kind: 'invalid', errors: ['The ## Workstreams section has no ```workstreams fenced block'] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { kind: 'invalid', errors: [`The block is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!isRecord(raw)) return { kind: 'invalid', errors: ['The block must be a JSON object'] };
  const errors: string[] = [];

  if (typeof raw.fannedOut !== 'boolean') errors.push('fannedOut must be a boolean');
  if (!isCount(raw.maxParallel) || raw.maxParallel < 1) errors.push('maxParallel must be an integer of at least 1');

  const list: WorkstreamRecord[] = [];
  if (!Array.isArray(raw.workstreams)) errors.push('workstreams must be a list (empty when the work was not fanned out)');
  else
    raw.workstreams.forEach((w: unknown, i) => {
      const at = `workstreams[${String(i)}]`;
      if (!isRecord(w) || typeof w.name !== 'string' || w.name.trim() === '' || typeof w.goal !== 'string') {
        errors.push(`${at} needs a name and a goal`);
        return;
      }
      const state = WORKSTREAM_STATES.find((s) => s === w.state);
      const duration = w.durationMinutes === undefined ? null : w.durationMinutes;
      const problems = [
        ...(!isNameList(w.predictedFiles) ? ['predictedFiles'] : []),
        ...(!isNameList(w.actualFiles) ? ['actualFiles'] : []),
        ...(!isNameList(w.needs) ? ['needs'] : []),
        ...(!isNameList(w.conflicts) ? ['conflicts'] : []),
      ];
      if (problems.length > 0) errors.push(`${at} (${w.name}): ${problems.join(', ')} must be lists of non-empty strings`);
      if (state === undefined) errors.push(`${at} (${w.name}): state must be one of ${WORKSTREAM_STATES.join(', ')}`);
      if (!isCount(w.attempts)) errors.push(`${at} (${w.name}): attempts must be an integer of at least 0`);
      if (!(duration === null || isCount(duration))) errors.push(`${at} (${w.name}): durationMinutes must be an integer of at least 0 or null`);
      if (
        problems.length === 0 &&
        state !== undefined &&
        isNameList(w.predictedFiles) &&
        isNameList(w.actualFiles) &&
        isNameList(w.needs) &&
        isNameList(w.conflicts) &&
        isCount(w.attempts) &&
        (duration === null || isCount(duration))
      ) {
        list.push({
          name: w.name.trim(),
          goal: w.goal.trim(),
          predictedFiles: w.predictedFiles,
          actualFiles: w.actualFiles,
          needs: w.needs,
          state,
          attempts: w.attempts,
          conflicts: w.conflicts,
          durationMinutes: duration,
        });
      }
    });

  const names = new Set<string>();
  for (const w of list) {
    if (names.has(w.name)) errors.push(`workstream name "${w.name}" is used twice`);
    names.add(w.name);
  }
  for (const w of list)
    for (const n of w.needs) if (!names.has(n)) errors.push(`workstream "${w.name}" needs "${n}", which is not a workstream`);
  const loop = cyclic(list);
  if (loop.length > 0) errors.push(`needs form a cycle through ${loop.join(', ')}`);
  if (raw.fannedOut === true && Array.isArray(raw.workstreams) && raw.workstreams.length < 2)
    errors.push('fannedOut is true, which needs at least 2 workstreams');
  if (isCount(raw.maxParallel) && list.length > 0 && raw.maxParallel > list.length)
    errors.push(`maxParallel (${String(raw.maxParallel)}) is more than the ${String(list.length)} workstreams`);

  if (errors.length > 0) return { kind: 'invalid', errors };
  return { kind: 'ok', block: { fannedOut: raw.fannedOut === true, maxParallel: Number(raw.maxParallel), workstreams: list } };
};

/** The note stored and shown with a malformed workstreams block. */
export const workstreamsValidationNote = (errors: readonly string[]): string => `Workstreams block not parsed: ${errors.join('; ')}`;

/** True when two parsed blocks say the same thing, so a re-pushed record doesn't record a change. */
export const sameWorkstreams = (a: WorkstreamsBlock, b: WorkstreamsBlock): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The event data for a block: the parsed block plus where it was read from. */
export const workstreamsEventData = (
  block: WorkstreamsBlock,
  from: { readonly version: number; readonly commitSha: string | null; readonly runId: string | null },
): { readonly [key: string]: JsonValue } => ({
  fannedOut: block.fannedOut,
  maxParallel: block.maxParallel,
  workstreams: block.workstreams.map((w) => ({
    name: w.name,
    goal: w.goal,
    predictedFiles: [...w.predictedFiles],
    actualFiles: [...w.actualFiles],
    needs: [...w.needs],
    state: w.state,
    attempts: w.attempts,
    conflicts: [...w.conflicts],
    durationMinutes: w.durationMinutes,
  })),
  version: from.version,
  commitSha: from.commitSha,
  runId: from.runId,
});
