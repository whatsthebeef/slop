import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = pathToFileURL(join(__dirname, '../../../scripts/renumber-migrations.mjs')).href;

const root = mkdtempSync(join(tmpdir(), 'renumber-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const rel = 'apps/server/drizzle';
const write = (path: string, content: unknown) => {
  const file = join(root, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
};
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
const entry = (idx: number, tag: string, when: number) => ({ idx, version: '7', when, tag, breakpoints: true });
const snapshot = (id: string, prevId: string, columns: string[]) => ({
  id, prevId, version: '7', dialect: 'postgresql', enums: {}, schemas: {},
  tables: { 'public.t': { name: 't', columns: Object.fromEntries(columns.map((c) => [c, { name: c }])) } },
});

describe('renumber-migrations', () => {
  it('renumbers, rechains and folds, and a second run changes nothing', async () => {
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    // Shared history: 0000, then main adds 0001_main_col and the branch adds 0001_branch_col.
    write(`${rel}/0000_init.sql`, 'create table t (a int);');
    write(`${rel}/meta/0000_snapshot.json`, snapshot('s0', 'none', ['a']));
    write(`${rel}/meta/_journal.json`, { version: '7', dialect: 'postgresql', entries: [entry(0, '0000_init', 100)] });
    git('add', '-A');
    git('commit', '-qm', 'base');
    // The branch commit, with its own migration at 0001.
    write(`${rel}/0001_branch_col.sql`, 'alter table t add c;');
    write(`${rel}/meta/0001_snapshot.json`, snapshot('sb', 's0', ['a', 'c']));
    write(`${rel}/meta/_journal.json`, {
      version: '7', dialect: 'postgresql', entries: [entry(0, '0000_init', 100), entry(1, '0001_branch_col', 150)],
    });
    write('apps/server/test/x.test.ts', "const MIGRATION = '0001_branch_col';\n");
    git('add', '-A');
    git('commit', '-qm', 'branch');
    // Main's commit, then the merge left resolved to main's side (plus the branch's SQL).
    git('checkout', '-q', '-b', 'main', 'HEAD~1');
    write(`${rel}/0001_main_col.sql`, 'alter table t add b;');
    write(`${rel}/meta/0001_snapshot.json`, snapshot('sm', 's0', ['a', 'b']));
    write(`${rel}/meta/_journal.json`, {
      version: '7', dialect: 'postgresql', entries: [entry(0, '0000_init', 100), entry(1, '0001_main_col', 200)],
    });
    git('add', '-A');
    git('commit', '-qm', 'main');
    git('checkout', '-q', '-', '--');
    git('merge', '-q', '-s', 'ours', 'main', '-m', 'merge');
    git('checkout', 'main', '--', `${rel}/0001_main_col.sql`, `${rel}/meta/0001_snapshot.json`, `${rel}/meta/_journal.json`);

    const { renumber } = await import(script);
    const first = renumber({ root, base: 'main', log: () => {} });
    expect(first.renamed).toEqual([{ from: '0001_branch_col', to: '0002_branch_col' }]);
    expect(existsSync(join(root, `${rel}/0002_branch_col.sql`))).toBe(true);
    expect(existsSync(join(root, `${rel}/0001_branch_col.sql`))).toBe(false);
    expect(first.references).toHaveLength(1);
    expect(readFileSync(join(root, 'apps/server/test/x.test.ts'), 'utf8')).toContain('0002_branch_col');

    const journal = read(`${rel}/meta/_journal.json`);
    expect(journal.entries.map((e: { idx: number; tag: string }) => [e.idx, e.tag])).toEqual([
      [0, '0000_init'], [1, '0001_main_col'], [2, '0002_branch_col'],
    ]);
    expect(journal.entries[2].when).toBeGreaterThan(200);
    const snap = read(`${rel}/meta/0002_snapshot.json`);
    expect(snap.prevId).toBe('sm');
    expect(Object.keys(snap.tables['public.t'].columns).sort()).toEqual(['a', 'b', 'c']);
    expect(read(`${rel}/meta/0001_snapshot.json`).id).toBe('sm');

    const before = readFileSync(join(root, `${rel}/meta/_journal.json`), 'utf8');
    const second = renumber({ root, base: 'main', log: () => {} });
    expect(second.renamed).toEqual([]);
    expect(readFileSync(join(root, `${rel}/meta/_journal.json`), 'utf8')).toBe(before);
    expect(read(`${rel}/meta/0002_snapshot.json`)).toEqual(snap);
  });
});
