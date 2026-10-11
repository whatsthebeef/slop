/** What the code view returns, its caps, and the light parser behind its import graph. Pure: nothing here reads a repository. */

import { GLOB_ID_SOURCE } from './ids.js';

/** Largest answers; every tool result is cut to these so a call can't flood a model's context. */
export const CODE_TREE_LIMIT = 500;
export const CODE_READ_LINES = 2000;
export const CODE_READ_CHARS = 100_000;
/** A file bigger than this is refused rather than read into memory. */
export const CODE_READ_MAX_BYTES = 1_000_000;
export const CODE_GREP_DEFAULT = 50;
export const CODE_GREP_MAX = 200;
export const CODE_GREP_PATHS_MAX = 20;
export const CODE_HISTORY_DEFAULT = 20;
export const CODE_HISTORY_MAX = 50;
export const CODE_IMPORTS_MAX = 200;
export const CODE_TOUCHED_PATHS_MAX = 100;
/** Per path, the index keeps this many newest commits. */
export const CODE_HISTORY_KEPT = 20;

export interface CodeTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'dir';
  /** Bytes; null for a directory or when the source can't say. */
  readonly size: number | null;
}

export interface CodeFile {
  readonly path: string;
  /** The requested lines (all of the file when it is short), empty for a binary file. */
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
  readonly binary: boolean;
}

export interface CodeGrepHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface CodeGrepResult {
  readonly hits: readonly CodeGrepHit[];
  /** True when more matched than `hits` holds. */
  readonly truncated: boolean;
}

/** One commit that changed a path, with the glob it came from and the merged change's summary when slop has one. */
export interface CodePathCommit {
  readonly sha: string;
  readonly subject: string;
  readonly date: string;
  readonly globId: string | null;
  readonly change: { readonly title: string; readonly url: string | null } | null;
}

export interface CodeImportRef {
  readonly path: string;
  readonly module: string;
}

export interface CodeTouchedModule {
  readonly module: string;
  readonly paths: readonly string[];
  /** Files outside the touched set that import any of its paths. */
  readonly importers: readonly CodeImportRef[];
  readonly fanIn: number;
}

export interface CodeLineRange {
  readonly start: number;
  readonly end: number;
}

/** What a consumer of the code view is; the usage counters are kept per consumer. */
export type CodeViewConsumer = string;

/** Thrown by a `CodeView` when the clone can't reach the ref and no fallback could answer. */
export class CodeViewUnavailable extends Error {}

/** Thrown by a `CodeView` when the request itself is wrong in a way only the repository shows (a regular expression git rejects). */
export class CodeViewInvalid extends Error {}

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', swift: 'swift', sh: 'shell', bash: 'shell',
  sql: 'sql', css: 'css', scss: 'css', html: 'html', md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
};

export const languageOf = (path: string): string | null => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? null : (LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null);
};

/** Top-level folders that group several modules: `apps/server` is a module, `docs` is one by itself. */
const MODULE_ROOTS: ReadonlySet<string> = new Set(['apps', 'packages', 'services', 'libs', 'modules', 'crates', 'cmd']);

/** The module a path belongs to: its folder under a workspace root (`apps/server`), else its top-level folder, else `.`. */
export const moduleOf = (path: string): string => {
  const parts = path.split('/');
  if (parts.length < 2) return '.';
  const [first, second] = parts;
  return first !== undefined && second !== undefined && MODULE_ROOTS.has(first) && parts.length > 2 ? `${first}/${second}` : (first ?? '.');
};

const SCRIPT = new Set(['typescript', 'javascript']);

/** Whether the import graph reads this language. */
export const hasImports = (language: string | null): boolean => language !== null && (SCRIPT.has(language) || language === 'python');

const SCRIPT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /^\s*import\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/**
 * The import specifiers named on one line of source. A light line-based reader, not a parser: a multi-line import is
 * caught on its `} from '…'` line, and anything it can't see is a missing edge, never a wrong one.
 */
export const importSpecifiers = (language: string | null, line: string): string[] => {
  if (line.length > 500) return [];
  const found: string[] = [];
  if (language !== null && SCRIPT.has(language)) {
    for (const pattern of SCRIPT_PATTERNS) for (const m of line.matchAll(pattern)) if (m[1] !== undefined) found.push(m[1]);
  } else if (language === 'python') {
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\b/.exec(line);
    if (from?.[1] !== undefined && from[1] !== '') found.push(from[1]);
    const plain = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(line);
    if (plain?.[1] !== undefined) found.push(...plain[1].split(',').map((p) => p.trim()));
  }
  return found;
};

/** `a/b/../c` → `a/c`; null when it climbs out of the repository. */
const normalise = (path: string): string | null => {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
};

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * The repository file an import points at, or null for a package, an alias or a file that isn't in the repository.
 * Only relative script imports and Python imports that resolve inside the repository count.
 */
export const resolveImport = (from: string, specifier: string, files: ReadonlySet<string>): string | null => {
  const language = languageOf(from);
  if (language !== null && SCRIPT.has(language)) {
    if (!specifier.startsWith('.')) return null;
    const base = normalise(`${dirOf(from)}/${specifier}`);
    if (base === null || base === '') return null;
    // TypeScript sources name the compiled extension: './x.js' is './x.ts'.
    const stem = base.replace(/\.(m|c)?jsx?$/, '');
    const candidates = [base, ...SCRIPT_EXTENSIONS.map((e) => `${stem}${e}`), ...SCRIPT_EXTENSIONS.map((e) => `${base}/index${e}`)];
    return candidates.find((c) => files.has(c) && c !== from) ?? null;
  }
  if (language === 'python') {
    const dots = /^\.*/.exec(specifier)?.[0].length ?? 0;
    const dotted = specifier.slice(dots).split('.').filter((p) => p !== '').join('/');
    let root = '';
    if (dots > 0) {
      let dir = dirOf(from);
      for (let i = 1; i < dots; i++) dir = dirOf(dir);
      root = dir;
    }
    const base = normalise(`${root}/${dotted}`);
    if (base === null || base === '') return null;
    return [`${base}.py`, `${base}/__init__.py`].find((c) => files.has(c) && c !== from) ?? null;
  }
  return null;
};

const SUBJECT_GLOB_ID = new RegExp(`^(${GLOB_ID_SOURCE}):`);
/** A history subject's glob ID: `s15f49: title` (slop's own commit format). */
export const globIdOfSubject = (subject: string): string | null => SUBJECT_GLOB_ID.exec(subject)?.[1] ?? null;

/** A ref a caller may name: a branch, tag, sha or `refs/pull/N/head`, never something git would read as an option. */
export const safeRef = (raw: string): string | null =>
  /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/.test(raw) && !raw.includes('..') && !raw.endsWith('/') && !raw.endsWith('.lock') ? raw : null;

/** The window of `text` a read returns: the lines asked for, cut to the line and character caps. */
export const windowOf = (path: string, text: string, range?: CodeLineRange): CodeFile => {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const start = Math.max(1, range?.start ?? 1);
  const wanted = Math.min(range?.end ?? start + CODE_READ_LINES - 1, start + CODE_READ_LINES - 1, lines.length);
  let content = lines.slice(start - 1, wanted).join('\n');
  let end = Math.max(start - 1, wanted);
  let truncated = wanted < Math.min(range?.end ?? lines.length, lines.length);
  if (content.length > CODE_READ_CHARS) {
    content = content.slice(0, CODE_READ_CHARS);
    end = start - 1 + content.split('\n').length;
    truncated = true;
  }
  return { path, content, startLine: start, endLine: end, totalLines: lines.length, truncated, binary: false };
};
