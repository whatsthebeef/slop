#!/usr/bin/env node
// Renumbers this branch's Drizzle migrations after merging main (scripts/dev.sh renumber-migrations).
//
// Main's migrations, SQL and snapshots stay exactly as they are. The branch's own migrations (the
// ones whose tags aren't in main's journal) move, in order, to the next free numbers: the SQL file,
// the snapshot, the journal entry (with a `when` above main's latest) and the snapshot's `prevId`.
// Main's schema changes are folded into each branch snapshot with a three-way merge against the
// snapshot the branch started from. Safe to run twice: a second run finds nothing to change.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const JOURNAL = 'meta/_journal.json';
const WHEN_STEP = 1000;

const num = (tag) => Number(/^(\d+)_/.exec(tag)?.[1] ?? NaN);
const pad = (n) => String(n).padStart(4, '0');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Three-way merge of snapshot JSON: main's change wins where the branch left the base alone. */
export function merge3(base, main, branch) {
  if (same(base, main)) return branch;
  if (same(base, branch)) return main;
  if (same(main, branch)) return branch;
  if (isObject(base ?? {}) && isObject(main ?? {}) && isObject(branch ?? {}) && (base || main || branch)) {
    const out = {};
    const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(main ?? {}), ...Object.keys(branch ?? {})]);
    for (const key of keys) {
      const merged = merge3(base?.[key], main?.[key], branch?.[key]);
      if (merged !== undefined) out[key] = merged;
    }
    return out;
  }
  return branch; // both changed the same value differently: the branch's intent stands
}

/**
 * @param {object} o
 * @param {string} o.drizzleDir  the checkout's apps/server/drizzle
 * @param {string} o.testDir     apps/server/test, scanned for references to old tags
 * @param {string} o.mainJournal main's journal, as text
 * @param {(rel: string) => string | null} o.readMain  a file under main's drizzle/, or null
 * @param {(rel: string) => string | null} o.readOurs  the branch's own copy of a file under drizzle/ (from git), or null
 * @param {(from: string, to: string) => void} o.mv
 * @param {(line: string) => void} [o.log]
 */
export function renumber({ drizzleDir, testDir, mainJournal, readMain, readOurs, mv, log = () => {} }) {
  const at = (rel) => join(drizzleDir, rel);
  const main = JSON.parse(mainJournal);
  const mainTags = new Set(main.entries.map((e) => e.tag));
  const mainLast = main.entries.reduce((a, e) => (e.idx > a.idx ? e : a));
  const mainIdx = new Set(main.entries.map((e) => num(e.tag)));
  const mainNext = Math.max(...main.entries.map((e) => num(e.tag))) + 1;
  const mainWhen = Math.max(...main.entries.map((e) => e.when));

  // The branch's migrations: journal entries (if the journal still parses) plus SQL files, minus main's.
  let current = [];
  try {
    current = JSON.parse(readFileSync(at(JOURNAL), 'utf8')).entries;
  } catch {
    // conflict markers: rely on the SQL files
  }
  const known = new Map(current.filter((e) => !mainTags.has(e.tag)).map((e) => [e.tag, e]));
  for (const file of readdirSync(drizzleDir)) {
    const tag = /^(\d{4}_.+)\.sql$/.exec(file)?.[1];
    if (tag && !mainTags.has(tag) && !known.has(tag)) known.set(tag, { version: main.entries[0].version, breakpoints: true, tag });
  }
  const branch = [...known.values()].sort((a, b) => num(a.tag) - num(b.tag) || a.tag.localeCompare(b.tag));
  if (branch.length === 0) {
    log('No branch migrations beyond main\'s: nothing to renumber.');
    return { renames: [], testRefs: [], changed: false };
  }

  // Snapshots: the working file, unless the number is one main uses (then it's main's), in which
  // case the branch's own copy comes from git.
  const snapshotRel = (n) => `meta/${pad(n)}_snapshot.json`;
  const snapshots = branch.map((e) => {
    const n = num(e.tag);
    const text = mainIdx.has(n) ? readOurs(snapshotRel(n)) : existsSync(at(snapshotRel(n))) ? readFileSync(at(snapshotRel(n)), 'utf8') : null;
    if (text === null) throw new Error(`No snapshot found for ${e.tag} (looked for ${snapshotRel(n)}${mainIdx.has(n) ? ' on the branch side in git' : ''})`);
    return JSON.parse(text);
  });

  // Fold main's schema changes in, relative to the snapshot the branch started from.
  const mainSnapshot = JSON.parse(readMain(snapshotRel(num(mainLast.tag))) ?? 'null');
  if (!mainSnapshot) throw new Error(`Main has no ${snapshotRel(num(mainLast.tag))}`);
  let base = null;
  if (snapshots[0].prevId !== mainSnapshot.id) {
    for (const e of main.entries) {
      const text = readMain(snapshotRel(num(e.tag)));
      if (text && JSON.parse(text).id === snapshots[0].prevId) base = JSON.parse(text);
    }
  }
  const folded = base ? snapshots.map((s) => merge3(base, mainSnapshot, s)) : snapshots;

  // Assign numbers, whens and the snapshot chain.
  let prevWhen = mainWhen;
  let prevId = mainSnapshot.id;
  const plan = branch.map((e, i) => {
    const n = mainNext + i;
    const tag = `${pad(n)}_${e.tag.replace(/^\d+_/, '')}`;
    const when = e.when > prevWhen ? e.when : prevWhen + WHEN_STEP;
    const snapshot = { ...folded[i], id: snapshots[i].id, prevId };
    prevWhen = when;
    prevId = snapshot.id;
    return { from: e.tag, to: tag, entry: { idx: main.entries.length + i, version: e.version, when, tag, breakpoints: e.breakpoints }, snapshot };
  });

  const renames = plan.filter((p) => p.from !== p.to);
  if (renames.length === 0) {
    log('Migrations are already numbered after main\'s: nothing to renumber.');
    return { renames: [], testRefs: [], changed: false };
  }

  // Move files, highest first so that a number is never overwritten before it has moved.
  const renamed = renames.map((p) => ({ from: p.from, to: p.to }));
  for (const p of [...renames].reverse()) {
    const fromNum = num(p.from);
    mv(at(`${p.from}.sql`), at(`${p.to}.sql`));
    if (mainIdx.has(fromNum)) continue; // that snapshot file is main's: leave it, write the new one below
    if (existsSync(at(snapshotRel(fromNum)))) mv(at(snapshotRel(fromNum)), at(snapshotRel(num(p.to))));
  }
  for (const p of plan) writeFileSync(at(snapshotRel(num(p.to))), json(p.snapshot));
  writeFileSync(at(JOURNAL), json({ ...main, entries: [...main.entries, ...plan.map((p) => p.entry)] }));

  // References in the server tests.
  const testRefs = [];
  if (existsSync(testDir)) {
    const map = new Map(renames.map((p) => [p.from, p.to]));
    const pattern = new RegExp(`(?<![A-Za-z0-9_])(${renames.map((p) => p.from).join('|')})(?![A-Za-z0-9_])`, 'g');
    for (const file of readdirSync(testDir, { recursive: true })) {
      const path = join(testDir, String(file));
      if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
      const text = readFileSync(path, 'utf8');
      if (!pattern.test(text)) continue;
      pattern.lastIndex = 0;
      writeFileSync(path, text.replace(pattern, (tag) => map.get(tag) ?? tag));
      testRefs.push(relative(testDir, path));
    }
  }

  for (const p of renames) log(`Renamed ${p.from} -> ${p.to}`);
  for (const f of testRefs) log(`Updated migration references in test/${f}`);
  log('');
  log('If a shared dev database has already run the old numbers: a migration from main with a lower');
  log('`when` than one already run will be skipped. Apply its SQL by hand, or scripts/dev.sh restore.');
  return { renames: renamed, testRefs, changed: true };
}

/** Runs drizzle-kit generate and removes whatever it wrote; returns whether it reported no changes. */
export function driftCheck(serverDir) {
  const drizzle = join(serverDir, 'drizzle');
  const list = () => new Set(readdirSync(drizzle, { recursive: true }).map(String));
  const before = list();
  const journal = readFileSync(join(drizzle, JOURNAL), 'utf8');
  let output;
  try {
    output = execFileSync('npx', ['drizzle-kit', 'generate', '--name', 'drift_check'], {
      cwd: serverDir,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=development`.trim() },
    });
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`;
  }
  for (const file of list()) if (!before.has(file)) rmSync(join(drizzle, file), { force: true });
  writeFileSync(join(drizzle, JOURNAL), journal);
  return { clean: /no schema changes/i.test(output), output };
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function main_() {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel'])?.trim();
  if (!root) throw new Error('Run this inside the slop checkout.');
  const serverDir = join(root, 'apps/server');
  const drizzleDir = join(serverDir, 'drizzle');
  const prefix = 'apps/server/drizzle';
  const base =
    process.argv[2] ??
    git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.trim() ??
    'origin/main';
  const show = (ref, rel) => git(root, ['show', `${ref}:${prefix}/${rel}`]);
  const mainJournal = show(base, JOURNAL);
  if (mainJournal === null) throw new Error(`Cannot read ${prefix}/${JOURNAL} from ${base}. Fetch it, or pass the base: renumber-migrations <ref>`);
  const mergeInProgress = existsSync(resolve(root, git(root, ['rev-parse', '--git-path', 'MERGE_HEAD'])?.trim() ?? 'MERGE_HEAD'));
  const readOurs = (rel) =>
    git(root, ['show', `:2:${prefix}/${rel}`]) ?? show(mergeInProgress ? 'HEAD' : 'HEAD^1', rel) ?? show('HEAD', rel);
  const mv = (from, to) => {
    try {
      execFileSync('git', ['mv', from, to], { cwd: root, stdio: 'ignore' });
    } catch {
      renameSync(from, to);
    }
  };

  console.log(`Main is ${base}.`);
  const result = renumber({ drizzleDir, testDir: join(serverDir, 'test'), mainJournal, readMain: (rel) => show(base, rel), readOurs, mv, log: console.log });
  git(root, ['add', '--', drizzleDir, join(serverDir, 'test')]);

  const drift = driftCheck(serverDir);
  if (!drift.clean) {
    console.error('\nFAILED: drizzle-kit still sees schema changes after renumbering (anything it generated was deleted):');
    console.error(drift.output);
    process.exit(1);
  }
  console.log(result.changed ? '\nDone. drizzle-kit reports no schema changes.' : '\ndrizzle-kit reports no schema changes.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main_();
  } catch (error) {
    console.error(`renumber-migrations: ${error.message}`);
    process.exit(1);
  }
}
