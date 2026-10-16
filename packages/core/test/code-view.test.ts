import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { CodeViewService } from '../src/app/code-view.js';
import type { CodeView, CodeViewUsage } from '../src/app/code-view.js';
import {
  CODE_GREP_MAX,
  CodeViewUnavailable,
  globIdOfSubject,
  importSpecifiers,
  languageOf,
  moduleOf,
  resolveImport,
  safeRef,
  windowOf,
} from '../src/domain/code-view.js';
import type { Result } from '../src/domain/errors.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const codeOf = <T>(result: Result<T>): string => (result.ok ? 'ok' : result.error.code);

describe('code view domain', () => {
  it('names a language by extension', () => {
    expect(languageOf('src/a.tsx')).toBe('typescript');
    expect(languageOf('a/b.py')).toBe('python');
    expect(languageOf('Makefile')).toBeNull();
    expect(languageOf('.gitignore')).toBeNull();
  });

  it('groups paths into modules', () => {
    expect(moduleOf('apps/server/src/main.ts')).toBe('apps/server');
    expect(moduleOf('packages/core/src/index.ts')).toBe('packages/core');
    expect(moduleOf('scripts/dev.sh')).toBe('scripts');
    expect(moduleOf('apps/readme.md')).toBe('apps');
    expect(moduleOf('package.json')).toBe('.');
  });

  it('reads import specifiers from single lines', () => {
    expect(importSpecifiers('typescript', "import { a } from './a.js';")).toEqual(['./a.js']);
    expect(importSpecifiers('typescript', "} from '../b';")).toEqual(['../b']);
    expect(importSpecifiers('typescript', "import './side';")).toEqual(['./side']);
    expect(importSpecifiers('typescript', "const m = await import('./lazy');")).toEqual(['./lazy']);
    expect(importSpecifiers('javascript', "const x = require('./x')")).toEqual(['./x']);
    expect(importSpecifiers('typescript', 'const from = 1;')).toEqual([]);
    expect(importSpecifiers('python', 'from .util import thing')).toEqual(['.util']);
    expect(importSpecifiers('python', 'import os, pkg.mod')).toEqual(['os', 'pkg.mod']);
    expect(importSpecifiers('typescript', `x from '${'a'.repeat(600)}'`)).toEqual([]);
  });

  it('resolves relative imports to repository files only', () => {
    const files = new Set(['src/a.ts', 'src/b.ts', 'src/lib/index.ts', 'src/c.tsx', 'pkg/__init__.py', 'pkg/util.py', 'pkg/sub/deep.py']);
    expect(resolveImport('src/a.ts', './b.js', files)).toBe('src/b.ts');
    expect(resolveImport('src/a.ts', './lib', files)).toBe('src/lib/index.ts');
    expect(resolveImport('src/a.ts', './c', files)).toBe('src/c.tsx');
    expect(resolveImport('src/a.ts', 'react', files)).toBeNull();
    expect(resolveImport('src/a.ts', '../../outside', files)).toBeNull();
    expect(resolveImport('src/a.ts', './a', files)).toBeNull();
    expect(resolveImport('pkg/sub/deep.py', '..util', files)).toBe('pkg/util.py');
    expect(resolveImport('pkg/util.py', 'pkg.sub.deep', files)).toBe('pkg/sub/deep.py');
  });

  it('finds the glob of a commit subject', () => {
    expect(globIdOfSubject('s15f49: Code view')).toBe('s15f49');
    expect(globIdOfSubject('s15k3: A decision')).toBe('s15k3');
    expect(globIdOfSubject('Merge pull request #3')).toBeNull();
  });

  it('refuses refs git would read as options or climb with', () => {
    expect(safeRef('main')).toBe('main');
    expect(safeRef('refs/pull/190/head')).toBe('refs/pull/190/head');
    expect(safeRef('s15f49')).toBe('s15f49');
    expect(safeRef('--upload-pack=x')).toBeNull();
    expect(safeRef('a..b')).toBeNull();
    expect(safeRef('')).toBeNull();
  });

  it('windows a file to the lines asked for', () => {
    const text = 'a\nb\nc\nd\n';
    expect(windowOf('x', text)).toMatchObject({ content: 'a\nb\nc\nd', startLine: 1, endLine: 4, totalLines: 4, truncated: false });
    expect(windowOf('x', text, { start: 2, end: 3 })).toMatchObject({ content: 'b\nc', startLine: 2, endLine: 3 });
    expect(windowOf('x', text, { start: 3, end: 99 })).toMatchObject({ content: 'c\nd', endLine: 4 });
    const long = Array.from({ length: 3000 }, (_, i) => String(i)).join('\n');
    expect(windowOf('x', long)).toMatchObject({ endLine: 2000, truncated: true });
  });
});

class FakeView implements CodeView {
  readonly calls: string[] = [];
  unavailable = false;
  grepLimit = 0;
  tree(_b: number, ref: string | null, path: string) {
    this.calls.push(`tree ${String(ref)} ${path}`);
    return Promise.resolve(path === 'missing' ? null : [{ name: 'a.ts', path: 'a.ts', type: 'file' as const, size: 3 }]);
  }
  read(_b: number, ref: string | null, path: string) {
    this.calls.push(`read ${String(ref)} ${path}`);
    if (this.unavailable) return Promise.reject(new CodeViewUnavailable('ref gone'));
    return Promise.resolve(path === 'a.ts' ? windowOf(path, 'hello\n') : null);
  }
  grep(_b: number, _ref: string | null, pattern: string, paths: readonly string[], limit: number) {
    this.calls.push(`grep ${pattern} [${paths.join(',')}]`);
    this.grepLimit = limit;
    return Promise.resolve({ hits: pattern === 'none' ? [] : [{ path: 'a.ts', line: 1, text: 'x' }], truncated: false });
  }
  history() {
    return Promise.resolve([]);
  }
  imports() {
    return Promise.resolve([{ path: 'b.ts', module: '.' }]);
  }
  importedBy() {
    return Promise.resolve([]);
  }
  touchedModules() {
    return Promise.resolve([]);
  }
}

describe('CodeViewService', () => {
  const MEMBER = 'dev@example.com';
  const STRANGER = 'stranger@example.com';
  let view: FakeView;
  let service: CodeViewService;
  let usage: string[];
  let boardId: number;
  let noRepoBoard: number;

  beforeEach(async () => {
    const store = new MemoryStore();
    const boards = new BoardService({ store, notifier: new RecordingNotifier() });
    await store.transaction(async (tx) => {
      for (const email of [MEMBER, STRANGER]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(MEMBER, { name: 'demo', repo: 'acme/app', timeZone: 'UTC', environments: [] })).id;
    noRepoBoard = unwrap(await boards.create(MEMBER, { name: 'bare', repo: null, timeZone: 'UTC', environments: [] })).id;
    view = new FakeView();
    usage = [];
    const recorder: CodeViewUsage = {
      record: (b, consumer, op, empty) => {
        usage.push(`${String(b)} ${consumer} ${op} ${String(empty)}`);
        return Promise.resolve();
      },
    };
    service = new CodeViewService({ boards, view, usage: recorder });
  });

  it('answers for a member and refuses a person who is not on the board', async () => {
    expect(unwrap(await service.read(MEMBER, { board: boardId, path: 'a.ts' })).content).toBe('hello');
    expect(codeOf(await service.read(STRANGER, { board: boardId, path: 'a.ts' }))).toBe('forbidden');
    expect(codeOf(await service.grep(STRANGER, { board: boardId, pattern: 'x' }))).toBe('forbidden');
    expect(view.calls).toEqual(['read null a.ts']);
  });

  it('refuses a board without a repository', async () => {
    expect(codeOf(await service.tree(MEMBER, { board: noRepoBoard }))).toBe('not_found');
  });

  it('vets paths, patterns and refs before they reach the view', async () => {
    expect(codeOf(await service.read(MEMBER, { board: boardId, path: '../etc/passwd' }))).toBe('invalid_input');
    expect(codeOf(await service.read(MEMBER, { board: boardId, path: '' }))).toBe('invalid_input');
    expect(codeOf(await service.tree(MEMBER, { board: boardId, path: '/abs' }))).toBe('invalid_input');
    expect(codeOf(await service.grep(MEMBER, { board: boardId, pattern: '-e foo' }))).toBe('invalid_input');
    expect(codeOf(await service.grep(MEMBER, { board: boardId, pattern: 'x', paths: ['..'] }))).toBe('invalid_input');
    expect(codeOf(await service.read(MEMBER, { board: boardId, path: 'a.ts', ref: '--output=x' }))).toBe('invalid_input');
    expect(codeOf(await service.read(MEMBER, { board: boardId, path: 'a.ts', start: 5, end: 2 }))).toBe('invalid_input');
    expect(view.calls).toEqual([]);
  });

  it('caps the number of matches asked for', async () => {
    unwrap(await service.grep(MEMBER, { board: boardId, pattern: 'x', limit: 10_000 }));
    expect(view.grepLimit).toBe(CODE_GREP_MAX);
  });

  it('maps a ref the view cannot reach to not_found, and a missing file too', async () => {
    view.unavailable = true;
    expect(codeOf(await service.read(MEMBER, { board: boardId, path: 'a.ts', ref: 'gone' }))).toBe('not_found');
    view.unavailable = false;
    expect(codeOf(await service.read(MEMBER, { board: boardId, path: 'nope.ts' }))).toBe('not_found');
    expect(codeOf(await service.tree(MEMBER, { board: boardId, path: 'missing' }))).toBe('not_found');
  });

  it('counts calls per consumer and whether they came back empty', async () => {
    unwrap(await service.grep(MEMBER, { board: boardId, pattern: 'x', consumer: 'size_check' }));
    unwrap(await service.grep(MEMBER, { board: boardId, pattern: 'none' }));
    unwrap(await service.imports(MEMBER, { board: boardId, path: 'a.ts', direction: 'importedBy' }));
    await Promise.resolve();
    expect(usage).toEqual([`${String(boardId)} size_check search_code false`, `${String(boardId)} mcp search_code true`, `${String(boardId)} mcp imports true`]);
  });

  it('needs paths for touched_modules', async () => {
    expect(codeOf(await service.touchedModules(MEMBER, { board: boardId, paths: [] }))).toBe('invalid_input');
    expect(codeOf(await service.touchedModules(MEMBER, { board: boardId, paths: ['a.ts'] }))).toBe('ok');
  });
});
