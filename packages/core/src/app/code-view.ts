import {
  CODE_GREP_DEFAULT,
  CODE_GREP_MAX,
  CODE_GREP_PATHS_MAX,
  CODE_HISTORY_DEFAULT,
  CODE_HISTORY_MAX,
  CODE_IMPORTS_MAX,
  CODE_TOUCHED_PATHS_MAX,
  CODE_TREE_LIMIT,
  CodeViewInvalid,
  CodeViewUnavailable,
  safeRef,
} from '../domain/code-view.js';
import type {
  CodeFile,
  CodeGrepResult,
  CodeImportRef,
  CodeLineRange,
  CodePathCommit,
  CodeTouchedModule,
  CodeTreeEntry,
  CodeViewConsumer,
} from '../domain/code-view.js';
import type { Result } from '../domain/errors.js';
import { invalidInput, notFound, ok } from '../domain/errors.js';
import { safeGrepPattern, safeRepoPath } from '../domain/review-tools.js';
import type { BoardService } from './board-service.js';

/**
 * A board's repository, read-only. `ref` null is the board's base branch (what the index describes); any other ref is a
 * branch, tag, sha or PR head, and only `tree`, `read` and `grep` answer for it. Nothing here runs the repository's code.
 * Implementations throw `CodeViewUnavailable` when a ref can't be reached and `CodeViewInvalid` for a request git rejects.
 */
export interface CodeView {
  /** The entries directly in a directory ('' is the root); null when there is no such directory. */
  tree(boardId: number, ref: string | null, path: string): Promise<readonly CodeTreeEntry[] | null>;
  /** The file's lines, or null when there is no such file. */
  read(boardId: number, ref: string | null, path: string, range?: CodeLineRange): Promise<CodeFile | null>;
  /** Lines matching the regular expression (`git grep -E` semantics), optionally under `paths`. */
  grep(boardId: number, ref: string | null, pattern: string, paths: readonly string[], limit: number): Promise<CodeGrepResult>;
  /** Newest-first commits that changed a path on the base branch, with merged-change summaries where slop has them. */
  history(boardId: number, path: string, limit: number): Promise<readonly CodePathCommit[]>;
  /** The files `path` imports. */
  imports(boardId: number, path: string): Promise<readonly CodeImportRef[]>;
  /** The files that import `path`. */
  importedBy(boardId: number, path: string): Promise<readonly CodeImportRef[]>;
  /** The modules a set of paths belong to, and who imports them from outside the set. */
  touchedModules(boardId: number, paths: readonly string[]): Promise<readonly CodeTouchedModule[]>;
}

/** Cheap per-consumer counters: which operations each consumer calls and how often they come back empty. */
export interface CodeViewUsage {
  record(boardId: number, consumer: CodeViewConsumer, op: string, empty: boolean): Promise<void>;
}

export interface CodeViewServiceDeps {
  readonly boards: Pick<BoardService, 'get'>;
  readonly view: CodeView;
  readonly usage?: CodeViewUsage;
  readonly warn?: (message: string) => void;
}

/** A result that also says whether the answer was empty, for the usage counters. */
const answer = <T>(value: T, empty: boolean): Result<T> & { empty: boolean } => ({ ok: true, value, empty });

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(max, Math.max(1, Math.trunc(value ?? fallback)));

/**
 * The code view for people and agents: every call is for a board the caller belongs to, inputs are vetted before they
 * reach git, and results are capped. Consumers pass their own name so the usage counters can tell them apart.
 */
export class CodeViewService {
  constructor(private readonly deps: CodeViewServiceDeps) {}

  tree(email: string, input: { board: number; ref?: string; path?: string; consumer?: CodeViewConsumer }): Promise<Result<{ entries: readonly CodeTreeEntry[]; truncated: boolean }>> {
    return this.call(email, input.board, 'list_dir', input.consumer, async () => {
      const path = safeRepoPath(input.path ?? '');
      if (path === null) return invalidInput('path must be relative to the repository root, without ".." or a leading "/"');
      const ref = this.ref(input.ref);
      if (!ref.ok) return ref;
      const entries = await this.deps.view.tree(input.board, ref.value, path);
      if (entries === null) return notFound(`No directory ${path === '' ? '(root)' : path}`);
      return answer({ entries: entries.slice(0, CODE_TREE_LIMIT), truncated: entries.length > CODE_TREE_LIMIT }, entries.length === 0);
    });
  }

  read(email: string, input: { board: number; ref?: string; path: string; start?: number; end?: number; consumer?: CodeViewConsumer }): Promise<Result<CodeFile>> {
    return this.call(email, input.board, 'read_file', input.consumer, async () => {
      const path = safeRepoPath(input.path);
      if (path === null || path === '') return invalidInput('path must name a file, relative to the repository root, without ".." or a leading "/"');
      const ref = this.ref(input.ref);
      if (!ref.ok) return ref;
      const range = input.start === undefined && input.end === undefined ? undefined : { start: Math.max(1, Math.trunc(input.start ?? 1)), end: Math.trunc(input.end ?? Number.MAX_SAFE_INTEGER) };
      if (range !== undefined && range.end < range.start) return invalidInput('end must not be before start');
      const file = await this.deps.view.read(input.board, ref.value, path, range);
      return file === null ? notFound(`No file ${path}`) : ok(file);
    });
  }

  grep(email: string, input: { board: number; ref?: string; pattern: string; paths?: readonly string[]; limit?: number; consumer?: CodeViewConsumer }): Promise<Result<CodeGrepResult>> {
    return this.call(email, input.board, 'search_code', input.consumer, async () => {
      const pattern = safeGrepPattern(input.pattern);
      if (pattern === null) return invalidInput('pattern must be a regular expression that is not empty, not long and does not start with "-"');
      const ref = this.ref(input.ref);
      if (!ref.ok) return ref;
      const raw = input.paths ?? [];
      if (raw.length > CODE_GREP_PATHS_MAX) return invalidInput(`At most ${CODE_GREP_PATHS_MAX} paths`);
      const paths: string[] = [];
      for (const p of raw) {
        const safe = safeRepoPath(p);
        if (safe === null) return invalidInput(`Bad path "${p}": relative to the repository root, without ".." or a leading "/"`);
        if (safe !== '') paths.push(safe);
      }
      const result = await this.deps.view.grep(input.board, ref.value, pattern, paths, clamp(input.limit, CODE_GREP_DEFAULT, CODE_GREP_MAX));
      return answer(result, result.hits.length === 0);
    });
  }

  history(email: string, input: { board: number; path: string; limit?: number; consumer?: CodeViewConsumer }): Promise<Result<readonly CodePathCommit[]>> {
    return this.call(email, input.board, 'path_history', input.consumer, async () => {
      const path = safeRepoPath(input.path);
      if (path === null || path === '') return invalidInput('path must name a file or folder, relative to the repository root');
      const commits = await this.deps.view.history(input.board, path, clamp(input.limit, CODE_HISTORY_DEFAULT, CODE_HISTORY_MAX));
      return answer(commits, commits.length === 0);
    });
  }

  imports(email: string, input: { board: number; path: string; direction?: 'imports' | 'importedBy'; consumer?: CodeViewConsumer }): Promise<Result<readonly CodeImportRef[]>> {
    return this.call(email, input.board, 'imports', input.consumer, async () => {
      const path = safeRepoPath(input.path);
      if (path === null || path === '') return invalidInput('path must name a file, relative to the repository root');
      const refs =
        input.direction === 'importedBy' ? await this.deps.view.importedBy(input.board, path) : await this.deps.view.imports(input.board, path);
      return answer(refs.slice(0, CODE_IMPORTS_MAX), refs.length === 0);
    });
  }

  touchedModules(email: string, input: { board: number; paths: readonly string[]; consumer?: CodeViewConsumer }): Promise<Result<readonly CodeTouchedModule[]>> {
    return this.call(email, input.board, 'touched_modules', input.consumer, async () => {
      if (input.paths.length === 0 || input.paths.length > CODE_TOUCHED_PATHS_MAX) return invalidInput(`Give 1 to ${CODE_TOUCHED_PATHS_MAX} paths`);
      const paths: string[] = [];
      for (const p of input.paths) {
        const safe = safeRepoPath(p);
        if (safe === null || safe === '') return invalidInput(`Bad path "${p}"`);
        paths.push(safe);
      }
      const modules = await this.deps.view.touchedModules(input.board, paths);
      return answer(modules, modules.length === 0);
    });
  }

  private ref(raw: string | undefined): Result<string | null> {
    if (raw === undefined || raw === '') return ok(null);
    const ref = safeRef(raw);
    return ref === null ? invalidInput(`"${raw}" is not a branch, tag, commit or pull request ref`) : ok(ref);
  }

  /** Membership check, the call, error mapping and the usage counter. `answer` marks an empty one. */
  private async call<T>(email: string, boardId: number, op: string, consumer: CodeViewConsumer | undefined, run: () => Promise<Result<T> & { empty?: boolean }>): Promise<Result<T>> {
    const member = await this.deps.boards.get(email, boardId);
    if (!member.ok) return member;
    if (member.value.board.repo === null || member.value.board.repo === '') return notFound(`Board ${String(boardId)} has no repository`);
    let result: Result<T> & { empty?: boolean };
    try {
      result = await run();
    } catch (error) {
      if (error instanceof CodeViewUnavailable) return notFound(error.message);
      if (error instanceof CodeViewInvalid) return invalidInput(error.message);
      throw error;
    }
    if (result.ok) {
      void this.deps.usage?.record(boardId, consumer ?? 'mcp', op, result.empty === true).catch((e: unknown) => this.deps.warn?.(`code view usage: ${e instanceof Error ? e.message : String(e)}`));
    }
    return result;
  }
}
