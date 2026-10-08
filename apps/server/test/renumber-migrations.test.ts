import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renumber } from '../../../scripts/renumber-migrations.mjs';

const entry = (idx: number, tag: string, when: number) => ({ idx, version: '7', when, tag, breakpoints: true });
const snapshot = (id: string, prevId: string, columns: string[]) => ({
  id,
  prevId,
  version: '7',
  dialect: 'postgresql',
  tables: { 'public.globs': { name: 'globs', columns: Object.fromEntries(columns.map((c) => [c, { name: c, type: 'text' }])) } },
});
const write = (path: string, value: unknown) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
interface Snap {
  id: string;
  prevId: string;
  tables: Record<string, { columns: Record<string, unknown> }>;
}
interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}
const readSnap = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Snap;
const readJournal = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Journal;
const columns = (s: Snap) => Object.keys((s.tables['public.globs'] as { columns: Record<string, unknown> }).columns).sort();

// Base 0020 (id b); main adds 0021_main_col (id m, column "m"); the branch adds 0021_branch_col (id x, column "x").
const BASE = snapshot('b', 'a', ['id']);
const MAIN = snapshot('m', 'b', ['id', 'm']);
const BRANCH = snapshot('x', 'b', ['id', 'x']);
const mainJournal = {
  version: '7',
  dialect: 'postgresql',
  entries: [entry(0, '0019_first', 1000), entry(1, '0020_base', 2000), entry(2, '0021_main_col', 5000)],
};

describe('renumber-migrations', () => {
  let dir: string;
  let drizzle: string;
  let tests: string;
  const run = () =>
    renumber({
      drizzleDir: drizzle,
      testDir: tests,
      mainJournal: JSON.stringify(mainJournal),
      readMain: (rel) => ({ 'meta/0020_snapshot.json': JSON.stringify(BASE), 'meta/0021_snapshot.json': JSON.stringify(MAIN) })[rel] ?? null,
      readOurs: (rel) => (rel === 'meta/0021_snapshot.json' ? JSON.stringify(BRANCH) : null),
      mv: renameSync,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'renumber-'));
    drizzle = join(dir, 'drizzle');
    tests = join(dir, 'test');
    mkdirSync(join(drizzle, 'meta'), { recursive: true });
    mkdirSync(tests);
    // The checkout after merging main with the drizzle conflicts resolved to main's side.
    for (const f of ['0019_first', '0020_base', '0021_main_col']) write(join(drizzle, `${f}.sql`), `-- ${f}\n`);
    write(join(drizzle, '0021_branch_col.sql'), '-- branch\n');
    write(join(drizzle, 'meta/0020_snapshot.json'), BASE);
    write(join(drizzle, 'meta/0021_snapshot.json'), MAIN);
    write(join(drizzle, 'meta/_journal.json'), mainJournal);
    write(join(tests, 'uses.test.ts'), "const MIGRATION = '0021_branch_col';\nconst other = '0021_main_col';\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('renumbers, rechains and folds in main\'s changes, leaving main\'s files alone', () => {
    const result = run();
    expect(result.renames).toEqual([{ from: '0021_branch_col', to: '0022_branch_col' }]);
    expect(result.testRefs).toEqual(['uses.test.ts']);
    expect(readdirSync(drizzle).sort()).toEqual(['0019_first.sql', '0020_base.sql', '0021_main_col.sql', '0022_branch_col.sql', 'meta']);
    expect(readFileSync(join(drizzle, '0021_main_col.sql'), 'utf8')).toBe('-- 0021_main_col\n');
    expect(readSnap(join(drizzle, 'meta/0021_snapshot.json'))).toEqual(MAIN);

    const journal = readJournal(join(drizzle, 'meta/_journal.json'));
    expect(journal.entries.map((e) => [e.idx, e.tag])).toEqual([
      [0, '0019_first'], [1, '0020_base'], [2, '0021_main_col'], [3, '0022_branch_col'],
    ]);
    expect((journal.entries[3] as { when: number }).when).toBeGreaterThan(5000);
    expect(journal.entries.slice(0, 3)).toEqual(mainJournal.entries);

    const moved = readSnap(join(drizzle, 'meta/0022_snapshot.json'));
    expect(moved.id).toBe('x');
    expect(moved.prevId).toBe('m');
    expect(columns(moved)).toEqual(['id', 'm', 'x']);
    expect(readFileSync(join(tests, 'uses.test.ts'), 'utf8')).toBe("const MIGRATION = '0022_branch_col';\nconst other = '0021_main_col';\n");
  });

  it('is a no-op the second time', () => {
    run();
    const first = readdirSync(drizzle, { recursive: true }).sort();
    const journal = readFileSync(join(drizzle, 'meta/_journal.json'), 'utf8');
    const snap = readFileSync(join(drizzle, 'meta/0022_snapshot.json'), 'utf8');
    const again = run();
    expect(again.changed).toBe(false);
    expect(again.renames).toEqual([]);
    expect(readdirSync(drizzle, { recursive: true }).sort()).toEqual(first);
    expect(readFileSync(join(drizzle, 'meta/_journal.json'), 'utf8')).toBe(journal);
    expect(readFileSync(join(drizzle, 'meta/0022_snapshot.json'), 'utf8')).toBe(snap);
  });

  it('orders several branch migrations after main\'s and chains them', () => {
    write(join(drizzle, '0022_branch_two.sql'), '-- two\n');
    write(join(drizzle, 'meta/0022_snapshot.json'), snapshot('y', 'x', ['id', 'x', 'y']));
    const result = run();
    expect(result.renames.map((r) => r.to)).toEqual(['0022_branch_col', '0023_branch_two']);
    const second = readSnap(join(drizzle, 'meta/0023_snapshot.json'));
    expect(second.prevId).toBe('x');
    expect(columns(second)).toEqual(['id', 'm', 'x', 'y']);
    const journal = readJournal(join(drizzle, 'meta/_journal.json'));
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
  });
});
