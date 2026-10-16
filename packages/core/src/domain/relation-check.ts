/**
 * The post-merge check of a relation (spec, Dependencies): when glob A merged after waiting for glob B, did A's diff use anything
 * B added, or change the same lines? Pure: it reads two merged diffs and the code index's import facts and decides `needed`,
 * `not_needed` or `unsure`. Only `unsure` goes to a model. The check never builds anything: imports and symbols stand in for
 * "would it have built without it".
 */
import type { DiffSummary } from './sub-gate.js';

export const CHECK_VERDICTS = ['needed', 'not_needed', 'unsure'] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

export interface CheckResult {
  readonly verdict: CheckVerdict;
  /** One line, naming the import or symbol that decided it. */
  readonly reason: string;
}

/** An import edge of the code index: file `from` imports file `to`. */
export interface ImportEdge {
  readonly from: string;
  readonly to: string;
}

/** The two merged diffs and what the index knows; `imports` null when the index could not be read. */
export interface CheckFacts {
  /** The glob that waited. */
  readonly a: { readonly id: string; readonly diff: DiffSummary };
  /** The glob it waited for. */
  readonly b: { readonly id: string; readonly diff: DiffSummary };
  /** Import edges from A's files to B's files, from the code index; null: unreadable. */
  readonly imports: readonly ImportEdge[] | null;
}

/** A symbol shorter than this is too common to prove a use. */
const MIN_SYMBOL = 3;
/** At most this many symbols of one glob are looked for. */
const MAX_SYMBOLS = 200;

const TS_EXPORT = /^\+\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const TS_EXPORT_LIST = /^\+\s*export\s*\{([^}]*)\}/;
const OTHER_DEF = /^\+\s*(?:async\s+)?(?:def|class|func|fn|function)\s+([A-Za-z_][\w]*)/;
const JS_FILE = /\.(?:[cm]?[jt]sx?)$/i;

const isJs = (path: string): boolean => JS_FILE.test(path);

/** The lines a patch adds (without the `+` marker's file header). */
const addedLines = (patch: string): string[] => patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));

/** The exported symbols a file's patch adds: `export const X`, `export function X`, ... for TS/JS, `def`/`class` for other languages. */
export const addedSymbols = (path: string, patch: string): string[] => {
  const out: string[] = [];
  for (const line of addedLines(patch)) {
    if (isJs(path)) {
      const m = TS_EXPORT.exec(line);
      if (m?.[1] !== undefined) out.push(m[1]);
      const list = TS_EXPORT_LIST.exec(line);
      if (list?.[1] !== undefined) {
        for (const part of list[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? '';
          if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
        }
      }
    } else {
      const m = OTHER_DEF.exec(line);
      if (m?.[1] !== undefined) out.push(m[1]);
    }
  }
  return out.filter((s) => s.length >= MIN_SYMBOL);
};

/** The symbols a diff adds, with the file each came from; test files are left out (nothing imports them). */
export const symbolsOf = (diff: DiffSummary): Map<string, string> => {
  const found = new Map<string, string>();
  for (const [path, patch] of Object.entries(diff.patches ?? {})) {
    if (/(^|\/)(test|tests|__tests__)\/|\.(?:test|spec)\./.test(path)) continue;
    for (const s of addedSymbols(path, patch)) if (!found.has(s) && found.size < MAX_SYMBOLS) found.set(s, path);
  }
  return found;
};

/** Whether the patch adds a line that uses `symbol` as an identifier (an added definition of it does not count). */
const usesIn = (patch: string, symbol: string): boolean => {
  const name = symbol.replace(/\$/g, '\\$');
  const word = new RegExp(`(?<![\\w$])${name}(?![\\w$])`);
  const defines = new RegExp(`(?:const|let|var|function\\*?|class|interface|type|enum|def|func|fn)\\s+${name}(?![\\w$])`);
  return addedLines(patch).some((l) => word.test(l) && !defines.test(l));
};

interface Range {
  readonly from: number;
  readonly to: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The old-side and new-side line ranges of each hunk of a patch. */
export const hunksOf = (patch: string): { readonly oldRange: Range; readonly newRange: Range; readonly created: boolean }[] => {
  const out: { oldRange: Range; newRange: Range; created: boolean }[] = [];
  for (const line of patch.split('\n')) {
    const m = HUNK.exec(line);
    if (m === null) continue;
    const oldStart = Number(m[1]);
    const oldLen = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newLen = m[4] === undefined ? 1 : Number(m[4]);
    out.push({
      oldRange: { from: oldStart, to: oldStart + Math.max(oldLen, 1) - 1 },
      newRange: { from: newStart, to: newStart + Math.max(newLen, 1) - 1 },
      created: oldStart === 0 && oldLen === 0,
    });
  }
  return out;
};

const overlaps = (x: Range, y: Range): boolean => x.from <= y.to && y.from <= x.to;

/** Whether B created the file (its patch is one hunk that starts from nothing). */
const createdBy = (patch: string): boolean => {
  const hunks = hunksOf(patch);
  return hunks.length > 0 && hunks.every((h) => h.created);
};

const quote = (s: string): string => `\`${s}\``;

/**
 * Decides one relation from facts. Order of proof: A's added lines use a symbol B added; A imports a file B created; A and B
 * changed the same lines of a file (A's old side is in the coordinates B's merge left, so it is compared with B's new side).
 * No shared file, import or symbol is `not_needed`. Anything the facts cannot settle (the same files without overlapping lines,
 * a file with no patch, an unreadable index) is `unsure`.
 */
export const judgeRelation = (facts: CheckFacts): CheckResult => {
  const { a, b } = facts;
  const aPatches = a.diff.patches ?? {};
  const bPatches = b.diff.patches ?? {};
  const bSymbols = symbolsOf(b.diff);
  const aOwn = new Set(symbolsOf(a.diff).keys());

  for (const [symbol] of bSymbols) {
    if (aOwn.has(symbol)) continue;
    for (const [path, patch] of Object.entries(aPatches)) {
      if (usesIn(patch, symbol)) return { verdict: 'needed', reason: `uses ${quote(symbol)} from ${b.id} (in ${path})` };
    }
  }

  const created = new Set(Object.entries(bPatches).filter(([, p]) => createdBy(p)).map(([path]) => path));
  const aFiles = new Set(a.diff.files);
  for (const edge of facts.imports ?? []) {
    if (aFiles.has(edge.from) && created.has(edge.to)) return { verdict: 'needed', reason: `imports ${quote(edge.to)} from ${b.id} (in ${edge.from})` };
  }

  const bFiles = new Set(b.diff.files);
  const shared = a.diff.files.filter((f) => bFiles.has(f));
  let missingPatch = false;
  for (const path of shared) {
    const ap = aPatches[path];
    const bp = bPatches[path];
    if (ap === undefined || bp === undefined) {
      missingPatch = true;
      continue;
    }
    const bHunks = hunksOf(bp);
    if (hunksOf(ap).some((h) => bHunks.some((g) => overlaps(h.oldRange, g.newRange)))) {
      return { verdict: 'needed', reason: `changes the same lines of ${quote(path)} as ${b.id}` };
    }
  }

  // A file with no patch (binary, very large) hides both symbols and lines: git cannot say.
  const hidden = [...a.diff.files.filter((f) => aPatches[f] === undefined), ...b.diff.files.filter((f) => bPatches[f] === undefined)];
  if (missingPatch || hidden.length > 0) return { verdict: 'unsure', reason: `a diff has no patch for ${quote(hidden[0] ?? shared[0] ?? 'a file')}` };
  if (shared.length > 0) return { verdict: 'unsure', reason: `both changed ${quote(shared[0] ?? '')} but not the same lines` };
  if (facts.imports === null) return { verdict: 'unsure', reason: 'the code index could not be read' };
  return { verdict: 'not_needed', reason: 'no shared files, imports or symbols' };
};

/** What the model is shown for one unsure relation: the relation's own reason, both file lists, B's symbols and A's matching lines. */
export interface UnsureCase {
  readonly relationId: string;
  readonly to: string;
  readonly reason: string | null;
  readonly why: string;
  readonly aFiles: readonly string[];
  readonly bFiles: readonly string[];
  readonly bSymbols: readonly string[];
  readonly snippets: readonly { readonly path: string; readonly patch: string }[];
}

export const MAX_CASE_FILES = 30;
export const MAX_CASE_SYMBOLS = 20;
export const MAX_SNIPPET_CHARS = 1200;
export const MAX_CASE_SNIPPETS = 3;

/** A's patches of the files both changed (else its first patches), cut to size. */
export const snippetsOf = (a: DiffSummary, b: DiffSummary): { path: string; patch: string }[] => {
  const bFiles = new Set(b.files);
  const patches = Object.entries(a.patches ?? {});
  const shared = patches.filter(([path]) => bFiles.has(path));
  const chosen = (shared.length > 0 ? shared : patches).slice(0, MAX_CASE_SNIPPETS);
  return chosen.map(([path, patch]) => ({ path, patch: patch.length > MAX_SNIPPET_CHARS ? `${patch.slice(0, MAX_SNIPPET_CHARS)}…` : patch }));
};
