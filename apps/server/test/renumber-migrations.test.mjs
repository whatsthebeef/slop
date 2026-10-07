import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { merge3, renumber } from '../../../scripts/renumber-migrations.mjs';

const entry = (idx, tag, when) => ({ idx, version: '7', when, tag, breakpoints: true });
const snapshot = (id, prevId, columns) => ({
  id,
  prevId,
  version: '7',
  tables: { 'public.t': { name: 't', columns: Object.fromEntries(columns.map((c) => [c, { name: c }])) } },
});
const columnsOf = (s) => Object.keys(s.tables['public.t'].columns);

describe('renumber-migrations', () => {
  let dir;
  let testDir;
  const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

  // main: 0000_init, 0001_main_col (adds m). Branch (off 0000): 0001_a (adds a), 0002_b (adds b).
  const mainJournal = { version: '7', dialect: 'postgresql', entries: [entry(0, '0000_init', 100), entry(1, '0001_main_col', 5000)] };
  const mainSnapshots = {
    'meta/0000_snapshot.json': snapshot('s0', 'none', ['id']),
    'meta/0001_snapshot.json': snapshot('m1', 's0', ['id', 'm']),
  };
  const branchSnapshots = {
    'meta/0001_snapshot.json': snapshot('b1', 's0', ['id', 'a']),
    'meta/0002_snapshot.json': snapshot('b2', 'b1', ['id', 'a', 'b']),
  };

  const run = () =>
    renumber({
      drizzleDir: dir,
      mainJournal,
      mainFile: (name) => (name.endsWith('.sql') ? null : name in mainSnapshots ? JSON.stringify(mainSnapshots[name]) : null),
      branchJournal: read('meta/_journal.json'),
      branchSnapshot: (name) => JSON.stringify(branchSnapshots[name]),
      move: renameSync,
      stage: () => {},
      testDir,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'renumber-'));
    testDir = join(dir, 'test');
    mkdirSync(join(dir, 'meta'));
    mkdirSync(testDir);
    // The merged checkout: main's files, plus the branch's SQL and journal; main's snapshot won the clash.
    for (const [name, value] of Object.entries(mainSnapshots)) writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
    writeFileSync(join(dir, '0000_init.sql'), 'init');
    writeFileSync(join(dir, '0001_main_col.sql'), 'main');
    writeFileSync(join(dir, '0001_a.sql'), 'a');
    writeFileSync(join(dir, '0002_b.sql'), 'b');
    writeFileSync(join(dir, 'meta/0002_snapshot.json'), JSON.stringify(branchSnapshots['meta/0002_snapshot.json'], null, 2));
    writeFileSync(
      join(dir, 'meta/_journal.json'),
      JSON.stringify({ ...mainJournal, entries: [...mainJournal.entries, entry(1, '0001_a', 1000), entry(2, '0002_b', 2000)] }, null, 2),
    );
    writeFileSync(join(testDir, 'a.test.ts'), "const MIGRATION = '0001_a'; const sql = '../drizzle/0002_b.sql';");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('moves the branch after main, rechains and folds main in', () => {
    const result = run();
    expect(result.renamed).toEqual(['0002_b -> 0003_b', '0001_a -> 0002_a']);
    expect(readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()).toEqual(['0000_init.sql', '0001_main_col.sql', '0002_a.sql', '0003_b.sql']);
    const journal = read('meta/_journal.json');
    expect(journal.entries.map((e) => [e.idx, e.tag])).toEqual([[0, '0000_init'], [1, '0001_main_col'], [2, '0002_a'], [3, '0003_b']]);
    expect(journal.entries[2].when).toBeGreaterThan(5000);
    expect(journal.entries[3].when).toBeGreaterThan(journal.entries[2].when);
    expect(read('meta/0001_snapshot.json')).toEqual(mainSnapshots['meta/0001_snapshot.json']);
    const [s2, s3] = [read('meta/0002_snapshot.json'), read('meta/0003_snapshot.json')];
    expect([s2.id, s2.prevId, s3.id, s3.prevId]).toEqual(['b1', 'm1', 'b2', 'b1']);
    expect(columnsOf(s2)).toEqual(expect.arrayContaining(['id', 'a', 'm']));
    expect(columnsOf(s3)).toEqual(expect.arrayContaining(['id', 'a', 'b', 'm']));
    expect(readFileSync(join(testDir, 'a.test.ts'), 'utf8')).toBe("const MIGRATION = '0002_a'; const sql = '../drizzle/0003_b.sql';");
    expect(result.references).toHaveLength(1);
  });

  it('is a no-op the second time', () => {
    run();
    const snapshotFiles = () => readdirSync(join(dir, 'meta')).map((f) => readFileSync(join(dir, 'meta', f), 'utf8'));
    const before = [snapshotFiles(), readFileSync(join(dir, '0003_b.sql'), 'utf8')];
    branchSnapshots['meta/0001_snapshot.json'] = read('meta/0002_snapshot.json');
    branchSnapshots['meta/0002_snapshot.json'] = read('meta/0003_snapshot.json');
    // the second run sees the branch under its new tags
    const again = renumber({
      drizzleDir: dir,
      mainJournal,
      mainFile: (name) => (name in mainSnapshots ? JSON.stringify(mainSnapshots[name]) : null),
      branchJournal: read('meta/_journal.json'),
      branchSnapshot: (name) => readFileSync(join(dir, name), 'utf8'),
      move: renameSync,
      stage: () => {},
      testDir,
    });
    expect(again.renamed).toEqual([]);
    expect(again.journalChanged).toBe(false);
    expect([snapshotFiles(), readFileSync(join(dir, '0003_b.sql'), 'utf8')]).toEqual(before);
  });

  it('merge3 keeps both sides\' changes', () => {
    expect(merge3({ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 3 })).toEqual({ x: 2, y: 3 });
    expect(merge3({ c: { a: 1 } }, { c: { a: 1, b: 2 } }, { c: { a: 1, m: 3 } })).toEqual({ c: { a: 1, b: 2, m: 3 } });
  });
});
