import { agentSetKind } from './knowledge.js';
import type { KnowledgeKind, KnowledgeLayer } from './knowledge.js';

/**
 * Layered agent set. A board's agent-set row is one of two layers over slop's catalog:
 * - `overlay`: the board's own additions to a catalog file, appended under `## Board rules`
 *   (markdown) or deep-merged onto it (`settings.json`);
 * - `file`: a whole file the board owns (one it added, or a legacy full copy of a catalog file).
 * A catalog file with no board row is served as the catalog has it, so catalog changes reach
 * every board without anyone merging.
 */
export const BOARD_RULES_HEADING = '## Board rules';

/** Which kinds take an overlay: markdown agent files append one, settings merge one as JSON. */
export const overlayKind = (kind: KnowledgeKind): 'markdown' | 'json' | null => {
  if (kind === 'agent' || kind === 'command' || kind === 'claude_md') return 'markdown';
  if (kind === 'settings') return 'json';
  return null;
};

const isBlank = (text: string) => text.trim() === '';

/** A catalog markdown file with the board's rules appended; the catalog text alone without any. */
export const appendOverlay = (catalog: string, overlay: string): string => {
  if (isBlank(overlay)) return catalog;
  const rules = overlay.trim();
  // An overlay written with its own heading isn't given a second one.
  const body = rules.startsWith(BOARD_RULES_HEADING) ? rules : `${BOARD_RULES_HEADING}\n\n${rules}`;
  return `${catalog.trimEnd()}\n\n${body}\n`;
};

type JsonObject = { readonly [key: string]: unknown };

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const entriesOf = (value: JsonObject): [string, unknown][] => Object.entries(value);

/**
 * Deep-merges `overlay` onto `base`: objects merge key by key, arrays concatenate without
 * duplicates (compared as JSON), and anything else in the overlay replaces the base value.
 */
export const mergeJson = (base: unknown, overlay: unknown): unknown => {
  if (isJsonObject(base) && isJsonObject(overlay)) {
    const merged = new Map<string, unknown>(entriesOf(base));
    for (const [key, value] of entriesOf(overlay)) {
      merged.set(key, merged.has(key) ? mergeJson(merged.get(key), value) : value);
    }
    return Object.fromEntries(merged);
  }
  if (isJsonArray(base) && isJsonArray(overlay)) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    const all: unknown[] = [...base, ...overlay];
    for (const value of all) {
      const key = JSON.stringify(value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  }
  return overlay;
};

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
};

/** Why an overlay can't be stored for a kind, or null when it can. */
export const overlayProblem = (kind: KnowledgeKind, overlay: string): string | null => {
  if (isBlank(overlay)) return null;
  const form = overlayKind(kind);
  if (form === null) return `A ${kind} file takes no board rules; it comes from the catalog as is`;
  if (form === 'json') {
    const parsed = parseJson(overlay);
    if (!parsed.ok || !isJsonObject(parsed.value)) return 'The settings overlay must be a JSON object';
  }
  return null;
};

/**
 * A catalog file with the board's overlay applied. Kinds without overlays, blank overlays and an
 * unreadable catalog settings file serve the catalog text unchanged.
 */
export const composeFile = (kind: KnowledgeKind, catalog: string, overlay: string): string => {
  if (isBlank(overlay)) return catalog;
  const form = overlayKind(kind);
  if (form === 'markdown') return appendOverlay(catalog, overlay);
  if (form === 'json') {
    const base = parseJson(catalog);
    const extra = parseJson(overlay);
    if (!base.ok || !extra.ok) return catalog;
    return `${JSON.stringify(mergeJson(base.value, extra.value), null, 2)}\n`;
  }
  return catalog;
};

export interface CatalogAgentFile {
  readonly path: string;
  readonly content: string;
}

export interface BoardAgentRow {
  readonly kind: KnowledgeKind;
  readonly name: string;
  readonly layer: KnowledgeLayer;
  readonly content: string;
}

/**
 * How a path in the board's agent set is served:
 * - `catalog`: from the catalog unchanged (no board row, or a blank overlay);
 * - `overlay`: catalog text plus the board's rules;
 * - `board_file`: a file the board added, not in the catalog;
 * - `override`: a whole board file shadowing a catalog file (a legacy fork);
 * - `orphaned`: an overlay whose catalog file no longer exists; not served.
 */
export type AgentSetEntryStatus = 'catalog' | 'overlay' | 'board_file' | 'override' | 'orphaned';

export interface AgentSetEntry {
  readonly path: string;
  readonly kind: KnowledgeKind;
  readonly status: AgentSetEntryStatus;
}

export interface ComposedAgentSet {
  /** The files to serve, sorted by path (placeholders unfilled). */
  readonly files: readonly { readonly path: string; readonly content: string }[];
  /** Every path the board's agent set knows about, orphans included, sorted by path. */
  readonly entries: readonly AgentSetEntry[];
}

/** The board's agent set: catalog files, each with any board layer applied, plus the board's own files. */
export const composeAgentSet = (catalog: readonly CatalogAgentFile[], rows: readonly BoardAgentRow[]): ComposedAgentSet => {
  const catalogFiles = new Map<string, { kind: KnowledgeKind; content: string }>();
  for (const file of catalog) {
    const kind = agentSetKind(file.path);
    if (kind !== null) catalogFiles.set(file.path, { kind, content: file.content });
  }
  const rowsByPath = new Map(rows.map((r) => [r.name, r]));
  const files: { path: string; content: string }[] = [];
  const entries: AgentSetEntry[] = [];

  for (const [path, file] of catalogFiles) {
    const row = rowsByPath.get(path);
    if (row === undefined) {
      files.push({ path, content: file.content });
      entries.push({ path, kind: file.kind, status: 'catalog' });
    } else if (row.layer === 'file') {
      files.push({ path, content: row.content });
      entries.push({ path, kind: row.kind, status: 'override' });
    } else {
      files.push({ path, content: composeFile(file.kind, file.content, row.content) });
      const blank = isBlank(row.content) || overlayKind(file.kind) === null;
      entries.push({ path, kind: file.kind, status: blank ? 'catalog' : 'overlay' });
    }
  }
  for (const row of rows) {
    if (catalogFiles.has(row.name)) continue;
    if (row.layer === 'file') {
      files.push({ path: row.name, content: row.content });
      entries.push({ path: row.name, kind: row.kind, status: 'board_file' });
    } else {
      entries.push({ path: row.name, kind: row.kind, status: 'orphaned' });
    }
  }
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  return { files: files.sort(byPath), entries: entries.sort(byPath) };
};

/** One line of a two-way diff: kept in both, only in `a` (removed) or only in `b` (added). */
export interface DiffLine {
  readonly op: 'same' | 'removed' | 'added';
  readonly text: string;
}

const splitLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  // A trailing newline ends the last line rather than starting an empty one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/**
 * A line diff from `a` to `b` by longest common subsequence: every line of both, in order, marked
 * same, removed (only in `a`) or added (only in `b`). Removals come before additions at a change.
 */
export const lineDiff = (a: string, b: string): DiffLine[] => {
  const left = splitLines(a);
  const right = splitLines(b);
  // Common prefix and suffix are cheap to peel off and keep the table small for typical edits.
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft--;
    endRight--;
  }
  const midLeft = left.slice(start, endLeft);
  const midRight = right.slice(start, endRight);
  const rows = midLeft.length;
  const cols = midRight.length;
  // lcs[i][j]: the LCS length of midLeft[i..] and midRight[j..], flattened.
  const lcs = new Uint32Array((rows + 1) * (cols + 1));
  const at = (i: number, j: number) => lcs[i * (cols + 1) + j] ?? 0;
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i * (cols + 1) + j] = midLeft[i] === midRight[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = left.slice(0, start).map((text) => ({ op: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    const l = midLeft[i];
    const r = midRight[j];
    if (i < rows && j < cols && l === r && l !== undefined) {
      out.push({ op: 'same', text: l });
      i++;
      j++;
    } else if (l !== undefined && (j >= cols || at(i + 1, j) >= at(i, j + 1))) {
      out.push({ op: 'removed', text: l });
      i++;
    } else if (r !== undefined) {
      out.push({ op: 'added', text: r });
      j++;
    }
  }
  for (const text of left.slice(endLeft)) out.push({ op: 'same', text });
  return out;
};

/** A diff line, or a run of unchanged lines left out of a diff shown with context. */
export type ContextDiffLine = DiffLine | { readonly op: 'skipped'; readonly count: number };

/**
 * A diff with only `context` unchanged lines around each change; longer unchanged runs become one
 * `skipped` marker, so a small change to a long file stays small. Empty when nothing changed.
 */
export const contextDiff = (diff: readonly DiffLine[], context = 3): ContextDiffLine[] => {
  const near = new Array<boolean>(diff.length).fill(false);
  diff.forEach((line, index) => {
    if (line.op === 'same') return;
    for (let i = Math.max(0, index - context); i <= Math.min(diff.length - 1, index + context); i++) near[i] = true;
  });
  if (!near.includes(true)) return [];
  const out: ContextDiffLine[] = [];
  let run: DiffLine[] = [];
  // A marker in place of a single line saves nothing, so that line is shown.
  const flush = () => {
    if (run.length === 1) out.push(...run);
    else if (run.length > 1) out.push({ op: 'skipped', count: run.length });
    run = [];
  };
  diff.forEach((line, index) => {
    if (near[index] === true) {
      flush();
      out.push(line);
    } else {
      run.push(line);
    }
  });
  flush();
  return out;
};
