import {
  CODE_READ_MAX_BYTES,
  CODE_TREE_LIMIT,
  CodeViewInvalid,
  CodeViewUnavailable,
  moduleOf,
  safeRepoPath,
  windowOf,
} from '@slop/core';
import type {
  Board,
  CodeFile,
  CodeGrepHit,
  CodeGrepResult,
  CodeImportRef,
  CodeLineRange,
  CodePathCommit,
  CodeTouchedModule,
  CodeTreeEntry,
  CodeView,
} from '@slop/core';
import type { CodeClones } from './code-clones.js';
import type { CodeIndex } from './code-index.js';
import type { CodeHost, Repo } from './codehost.js';
import { repoOf } from './codehost.js';

const GREP_OUTPUT_LIMIT = 4_000_000;
const HIT_TEXT_LIMIT = 300;
const GREP_LINE = /^[0-9a-f]{40}:(.+?):(\d+):(.*)$/;

const isMaxBuffer = (error: unknown): error is { stdout: string } =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && 'stdout' in error && typeof error.stdout === 'string';

/**
 * The code view over a board's local clone (`CodeClones`) and its Postgres index (`CodeIndex`). Trees, reads and searches
 * come from git on any ref the clone can fetch; history and the import graph come from the index of the base branch. When
 * the clone can't reach a ref, a read or a tree falls back to the code host's API (a search can't: there is nothing to grep).
 */
export class GitCodeView implements CodeView {
  constructor(
    private readonly deps: {
      readonly clones: CodeClones;
      readonly index: CodeIndex;
      readonly board: (boardId: number) => Promise<Board | null>;
      /** The API fallback for reads; null turns it off. */
      readonly host: Pick<CodeHost, 'readFile' | 'listDir'> | null;
    },
  ) {}

  async tree(boardId: number, ref: string | null, path: string): Promise<readonly CodeTreeEntry[] | null> {
    const repo = await this.repo(boardId);
    let sha: string;
    try {
      sha = await this.deps.clones.resolve(boardId, repo, ref);
    } catch (error) {
      if (!(error instanceof CodeViewUnavailable) || this.deps.host === null) throw error;
      const entries = await this.deps.host.listDir(repo, ref ?? repo.base, path);
      return entries === null
        ? null
        : entries
            .map((e) => ({ name: e.name, path: path === '' ? e.name : `${path}/${e.name}`, type: e.type, size: null }))
            .sort(byKind)
            .slice(0, CODE_TREE_LIMIT + 1);
    }
    const args = ['-c', 'core.quotepath=off', 'ls-tree', '-l', '-z', sha, ...(path === '' ? [] : ['--', `${path}/`])];
    const out = await this.deps.clones.git(boardId, args);
    const entries: CodeTreeEntry[] = [];
    for (const row of out.split('\0')) {
      const tab = row.indexOf('\t');
      if (tab < 0) continue;
      const [, type, , size] = row.slice(0, tab).split(/\s+/);
      if (type !== 'blob' && type !== 'tree') continue;
      const full = row.slice(tab + 1);
      entries.push({ name: full.slice(full.lastIndexOf('/') + 1), path: full, type: type === 'tree' ? 'dir' : 'file', size: type === 'tree' ? null : Number(size) || 0 });
    }
    if (entries.length === 0 && path !== '') return null;
    return entries.sort(byKind).slice(0, CODE_TREE_LIMIT + 1);
  }

  async read(boardId: number, ref: string | null, path: string, range?: CodeLineRange): Promise<CodeFile | null> {
    const repo = await this.repo(boardId);
    let sha: string;
    try {
      sha = await this.deps.clones.resolve(boardId, repo, ref);
    } catch (error) {
      if (!(error instanceof CodeViewUnavailable) || this.deps.host === null) throw error;
      const text = await this.deps.host.readFile(repo, ref ?? repo.base, path);
      return text === null ? null : windowOf(path, text, range);
    }
    const object = `${sha}:${path}`;
    let type: string;
    try {
      type = (await this.deps.clones.git(boardId, ['cat-file', '-t', object])).trim();
    } catch {
      return null;
    }
    if (type !== 'blob') return null;
    let text: string;
    let cut = false;
    try {
      text = await this.deps.clones.git(boardId, ['cat-file', 'blob', object], { maxBuffer: CODE_READ_MAX_BYTES });
    } catch (error) {
      if (!isMaxBuffer(error)) throw error;
      text = error.stdout;
      cut = true;
    }
    if (text.slice(0, 8000).includes('\0')) {
      return { path, content: '', startLine: 1, endLine: 0, totalLines: 0, truncated: false, binary: true };
    }
    const file = windowOf(path, text, range);
    return cut ? { ...file, truncated: true } : file;
  }

  async grep(boardId: number, ref: string | null, pattern: string, paths: readonly string[], limit: number): Promise<CodeGrepResult> {
    const repo = await this.repo(boardId);
    const sha = await this.deps.clones.resolve(boardId, repo, ref);
    let stdout: string;
    try {
      stdout = await this.deps.clones.git(
        boardId,
        ['-c', 'core.quotepath=off', 'grep', '-n', '-I', '-E', '--no-color', '--no-recurse-submodules', '-e', pattern, sha, '--', ...paths],
        // Exit status 1 is "no matches".
        { okCodes: [1], maxBuffer: GREP_OUTPUT_LIMIT },
      );
    } catch (error) {
      if (isMaxBuffer(error)) stdout = error.stdout;
      else if (typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim() !== '') {
        // A pattern git rejects exits 128 with its reason, which the caller can read.
        throw new CodeViewInvalid(error.stderr.trim().split('\n')[0] ?? 'The search was rejected');
      } else throw error;
    }
    const hits: CodeGrepHit[] = [];
    let truncated = false;
    for (const row of stdout.split('\n')) {
      const m = GREP_LINE.exec(row);
      const hitPath = m?.[1] === undefined ? null : safeRepoPath(m[1]);
      if (m === null || hitPath === null || hitPath === '') continue;
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      hits.push({ path: hitPath, line: Number(m[2]), text: (m[3] ?? '').slice(0, HIT_TEXT_LIMIT) });
    }
    return { hits, truncated };
  }

  async history(boardId: number, path: string, limit: number): Promise<readonly CodePathCommit[]> {
    return this.deps.index.history(boardId, path, limit);
  }

  async imports(boardId: number, path: string): Promise<readonly CodeImportRef[]> {
    return (await this.deps.index.importsOf(boardId, path)).map((p) => ({ path: p, module: moduleOf(p) }));
  }

  async importedBy(boardId: number, path: string): Promise<readonly CodeImportRef[]> {
    return (await this.deps.index.importedBy(boardId, path)).map((p) => ({ path: p, module: moduleOf(p) }));
  }

  async touchedModules(boardId: number, paths: readonly string[]): Promise<readonly CodeTouchedModule[]> {
    const inside = [...new Set(paths)];
    const byModule = new Map<string, { paths: string[]; importers: Map<string, CodeImportRef> }>();
    for (const p of inside) {
      const m = moduleOf(p);
      const entry = byModule.get(m) ?? { paths: [], importers: new Map<string, CodeImportRef>() };
      entry.paths.push(p);
      byModule.set(m, entry);
    }
    for (const { from, to } of await this.deps.index.importersOf(boardId, inside)) {
      byModule.get(moduleOf(to))?.importers.set(from, { path: from, module: moduleOf(from) });
    }
    return [...byModule.entries()]
      .map(([module, { paths: modulePaths, importers }]) => ({ module, paths: modulePaths.sort(), importers: [...importers.values()].sort((a, b) => a.path.localeCompare(b.path)), fanIn: importers.size }))
      .sort((a, b) => b.fanIn - a.fanIn || a.module.localeCompare(b.module));
  }

  private async repo(boardId: number): Promise<Repo> {
    const board = await this.deps.board(boardId);
    const repo = board === null ? null : repoOf(board);
    if (repo === null) throw new CodeViewUnavailable(`Board ${String(boardId)} has no repository`);
    return repo;
  }
}

const byKind = (a: CodeTreeEntry, b: CodeTreeEntry): number => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
