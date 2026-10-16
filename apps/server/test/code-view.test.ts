import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardService, CodeViewService } from '@slop/core';
import type { Result } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeClones } from '../src/code-clones.js';
import { CodeIndex } from '../src/code-index.js';
import { CodeIndexer } from '../src/code-indexer.js';
import { GitCodeView } from '../src/code-view.js';
import type { Repo } from '../src/codehost.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { FakeCodeHost } from './support/fake-codehost.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const STRANGER = 'stranger@example.com';
const repo: Repo = { owner: 'o', name: 'n', base: 'main' };

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('The code view over a local clone and the Postgres index', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let boardId: number;
  let origin: string;
  let work: string;
  let host: FakeCodeHost;
  let clones: CodeClones;
  let index: CodeIndex;
  let indexer: CodeIndexer;
  let service: CodeViewService;
  let clock = Date.now();
  const notifier = { publish: () => undefined };

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(join(origin, path.slice(0, Math.max(0, path.lastIndexOf('/')))), { recursive: true });
    writeFileSync(join(origin, path), text);
  };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'slop-codeview-'));
    origin = join(work, 'origin');
    mkdirSync(origin);
    git('init', '--quiet', '-b', 'main');
    write('apps/server/src/a.ts', "import { b } from './b.js';\nexport const a = b + 1;\n");
    write('apps/server/src/b.ts', 'export const b = 1;\n');
    write('packages/core/src/c.ts', "import { b } from '../../../apps/server/src/b.js';\nexport const c = b;\n");
    write('README.md', '# demo\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 's1t1: first');
    write('apps/server/src/b.ts', 'export const b = 2;\n');
    git('commit', '--quiet', '-am', 's1t2: change b');
    git('checkout', '--quiet', '-b', 'feature');
    write('apps/server/src/feature.ts', 'export const onlyOnFeature = 1;\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 's1t3: feature work');
    git('update-ref', 'refs/pull/1/head', 'HEAD');
    git('checkout', '--quiet', 'main');

    ({ database, drop } = await createTestDatabase('code_view'));
    store = new PgStore(database.db);
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: DEV, active: true });
      await tx.upsertUser({ email: STRANGER, name: STRANGER, active: true });
    });
    const boards = new BoardService({ store, notifier });
    boardId = unwrap(await boards.create(DEV, { name: 'b', repo: 'o/n', timeZone: 'UTC', environments: [] })).id;
    host = new FakeCodeHost();
    clones = new CodeClones({ dir: join(work, 'clones'), host, remote: () => origin, now: () => clock });
    index = new CodeIndex(database.db);
    indexer = new CodeIndexer({ store, clones, index });
    const view = new GitCodeView({ clones, index, board: (id) => store.transaction((tx) => tx.getBoard(id)), host });
    service = new CodeViewService({ boards, view, usage: index });
    await indexer.syncBoard(boardId);
  });

  afterAll(async () => {
    await drop();
    rmSync(work, { recursive: true, force: true });
  });

  it('indexes the base branch: the import graph resolves relative imports to repository files', async () => {
    expect(await index.commitOf(boardId)).toBe(git('rev-parse', 'main'));
    expect(unwrap(await service.imports(DEV, { board: boardId, path: 'apps/server/src/a.ts' }))).toEqual([{ path: 'apps/server/src/b.ts', module: 'apps/server' }]);
    expect(unwrap(await service.imports(DEV, { board: boardId, path: 'apps/server/src/b.ts', direction: 'importedBy' })).map((r) => r.path)).toEqual([
      'apps/server/src/a.ts',
      'packages/core/src/c.ts',
    ]);
  });

  it('touchedModules returns the modules of a set of paths and who imports them from outside', async () => {
    const modules = unwrap(await service.touchedModules(DEV, { board: boardId, paths: ['apps/server/src/b.ts'] }));
    expect(modules).toEqual([
      {
        module: 'apps/server',
        paths: ['apps/server/src/b.ts'],
        importers: [
          { path: 'apps/server/src/a.ts', module: 'apps/server' },
          { path: 'packages/core/src/c.ts', module: 'packages/core' },
        ],
        fanIn: 2,
      },
    ]);
    // A file that imports it, in the touched set, is not an outside importer.
    const both = unwrap(await service.touchedModules(DEV, { board: boardId, paths: ['apps/server/src/b.ts', 'apps/server/src/a.ts'] }));
    expect(both[0]?.importers.map((i) => i.path)).toEqual(['packages/core/src/c.ts']);
  });

  it('keeps path history with the glob each commit came from, newest first, for files and folders', async () => {
    const file = unwrap(await service.history(DEV, { board: boardId, path: 'apps/server/src/b.ts' }));
    expect(file.map((c) => [c.subject, c.globId])).toEqual([['s1t2: change b', 's1t2'], ['s1t1: first', 's1t1']]);
    expect(unwrap(await service.history(DEV, { board: boardId, path: 'apps/server' })).map((c) => c.globId)).toEqual(['s1t2', 's1t1']);
    expect(unwrap(await service.history(DEV, { board: boardId, path: 'README.md' })).map((c) => c.globId)).toEqual(['s1t1']);
  });

  it('lists a directory, reads a line range and refuses what is not there', async () => {
    const root = unwrap(await service.tree(DEV, { board: boardId }));
    expect(root.entries.map((e) => [e.name, e.type])).toEqual([['apps', 'dir'], ['packages', 'dir'], ['README.md', 'file']]);
    expect(unwrap(await service.tree(DEV, { board: boardId, path: 'apps/server/src' })).entries.map((e) => e.path)).toEqual(['apps/server/src/a.ts', 'apps/server/src/b.ts']);
    expect(unwrap(await service.read(DEV, { board: boardId, path: 'apps/server/src/a.ts', start: 2, end: 2 }))).toMatchObject({ content: 'export const a = b + 1;', startLine: 2, totalLines: 2 });
    expect(await service.read(DEV, { board: boardId, path: 'nope.ts' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await service.tree(DEV, { board: boardId, path: 'README.md' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('greps the base branch, optionally under paths, and reports a pattern git rejects', async () => {
    expect(unwrap(await service.grep(DEV, { board: boardId, pattern: 'export const b' })).hits).toEqual([{ path: 'apps/server/src/b.ts', line: 1, text: 'export const b = 2;' }]);
    expect(unwrap(await service.grep(DEV, { board: boardId, pattern: 'export const', paths: ['packages'] })).hits.map((h) => h.path)).toEqual(['packages/core/src/c.ts']);
    expect(unwrap(await service.grep(DEV, { board: boardId, pattern: 'nothing-like-this' })).hits).toEqual([]);
    expect(unwrap(await service.grep(DEV, { board: boardId, pattern: 'export const', limit: 1 }))).toMatchObject({ truncated: true });
    expect(await service.grep(DEV, { board: boardId, pattern: '(' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    // A path that looks like git magic is matched literally, never as a pathspec.
    expect(unwrap(await service.grep(DEV, { board: boardId, pattern: 'export', paths: [':(top)apps'] })).hits).toEqual([]);
  });

  it('greps a ref other than the base branch, fetching it on demand (a branch and a pull request head)', async () => {
    expect(unwrap(await service.grep(DEV, { board: boardId, pattern: 'onlyOnFeature' })).hits).toEqual([]);
    expect(unwrap(await service.grep(DEV, { board: boardId, pattern: 'onlyOnFeature', ref: 'feature' })).hits.map((h) => h.path)).toEqual(['apps/server/src/feature.ts']);
    expect(unwrap(await service.grep(DEV, { board: boardId, pattern: 'onlyOnFeature', ref: 'refs/pull/1/head' })).hits).toHaveLength(1);
    expect(unwrap(await service.read(DEV, { board: boardId, path: 'apps/server/src/feature.ts', ref: git('rev-parse', 'feature') })).content).toContain('onlyOnFeature');
    // The base branch itself is untouched by it.
    expect(unwrap(await service.tree(DEV, { board: boardId, path: 'apps/server/src' })).entries).toHaveLength(2);
  });

  it('falls back to the host for a read or a tree when the clone cannot reach the ref, but not for a search', async () => {
    host.readFile = (_r, ref, path) => Promise.resolve(`from host: ${ref} ${path}\n`);
    host.listDir = () => Promise.resolve([{ name: 'x.ts', type: 'file' }]);
    expect(unwrap(await service.read(DEV, { board: boardId, path: 'a.ts', ref: 'no-such-branch' })).content).toBe('from host: no-such-branch a.ts');
    expect(unwrap(await service.tree(DEV, { board: boardId, path: 'src', ref: 'no-such-branch' })).entries).toEqual([{ name: 'x.ts', path: 'src/x.ts', type: 'file', size: null }]);
    expect(await service.grep(DEV, { board: boardId, pattern: 'x', ref: 'no-such-branch' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('refuses a person who is not on the board, and counts the calls of those who are', async () => {
    expect(await service.grep(STRANGER, { board: boardId, pattern: 'export' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await service.read(STRANGER, { board: boardId, path: 'README.md' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    unwrap(await service.grep(DEV, { board: boardId, pattern: 'nothing-at-all', consumer: 'size_check' }));
    const rows = async () => (await database.db.execute(`select consumer, op, calls, empty_results from code_view_usage where board_id = ${String(boardId)} and consumer = 'size_check'`)) as unknown as { calls: number; empty_results: number }[];
    for (let i = 0; i < 50 && (await rows()).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await rows()).toEqual([expect.objectContaining({ op: 'search_code', calls: 1, empty_results: 1 })]);
  });

  it('keeps no git hooks in a clone and checks nothing out', () => {
    const clone = clones.clonePath(boardId);
    // An empty template: git's sample hooks are never copied in.
    expect(existsSync(join(clone, 'hooks')) ? readdirSync(join(clone, 'hooks')) : []).toEqual([]);
    expect(existsSync(join(clone, 'apps'))).toBe(false);
  });

  it('updates the clone and the index when the base branch moves, and only then', async () => {
    const before = await index.commitOf(boardId);
    expect(await indexer.syncBoard(boardId)).toBe(false);
    write('apps/server/src/d.ts', "import './b.js';\n");
    git('add', '.');
    git('commit', '--quiet', '-m', 's1t4: add d');
    expect(await indexer.syncBoard(boardId)).toBe(true);
    expect(await index.commitOf(boardId)).not.toBe(before);
    expect(await index.commitOf(boardId)).toBe(git('rev-parse', 'main'));
    expect(unwrap(await service.imports(DEV, { board: boardId, path: 'apps/server/src/b.ts', direction: 'importedBy' })).map((r) => r.path)).toContain('apps/server/src/d.ts');
    expect(unwrap(await service.history(DEV, { board: boardId, path: 'apps/server/src/d.ts' })).map((c) => c.globId)).toEqual(['s1t4']);
  });

  it('drops on-demand refs that went unused for a week when the base is next synced', async () => {
    const refs = () => execFileSync('git', ['for-each-ref', 'refs/slop/x'], { cwd: clones.clonePath(boardId), encoding: 'utf8' }).trim();
    expect(refs()).not.toBe('');
    clock += 8 * 24 * 60 * 60 * 1000;
    await clones.sync(boardId, repo);
    expect(refs()).toBe('');
    clock = Date.now();
  });

  it('refuses a repository that does not fit its cap, and leaves no clone behind', async () => {
    const tiny = new CodeClones({ dir: join(work, 'tiny'), host, remote: () => origin, capBytes: 1 });
    await expect(tiny.sync(99, repo)).rejects.toThrow('does not fit');
    expect(existsSync(tiny.clonePath(99))).toBe(false);
  });

  it('serialises fetches for one board', async () => {
    const results = await Promise.all([clones.sync(boardId, repo), clones.sync(boardId, repo), clones.sync(boardId, repo)]);
    expect(new Set(results.map((r) => r.sha)).size).toBe(1);
  });
});
