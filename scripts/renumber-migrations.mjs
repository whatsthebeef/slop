#!/usr/bin/env node
// Renumbers a branch's Drizzle migrations after merging main: run via `scripts/dev.sh
// renumber-migrations [base]` in a checkout that has merged main (conflicts in apps/server/drizzle
// left alone or resolved to main's side). Main's migrations stay as they are; the branch's own move
// to the next free numbers, their snapshots are rechained, main's schema additions are folded into
// them, references in apps/server/test follow, and drizzle-kit must then report no drift.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTIONS = ['tables', 'enums', 'schemas', 'sequences', 'roles', 'policies', 'views'];
const TABLE_PARTS = [
  'columns', 'indexes', 'foreignKeys', 'compositePrimaryKeys', 'uniqueConstraints',
  'policies', 'checkConstraints',
];
const WHEN_STEP = 1000;

const num = (tag) => Number(tag.slice(0, 4));
const pad = (n) => String(n).padStart(4, '0');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function gitShow(cwd, ref, path) {
  try {
    return git(cwd, ['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

function move(cwd, from, to) {
  try {
    git(cwd, ['mv', '-f', from, to]);
  } catch {
    renameSync(join(cwd, from), join(cwd, to));
  }
}

// Folds what `main` added (relative to the snapshot the branch started from) into `snapshot`.
function fold(snapshot, base, main) {
  let changed = false;
  for (const section of SECTIONS) {
    for (const [key, value] of Object.entries(main[section] ?? {})) {
      const before = base[section]?.[key];
      snapshot[section] ??= {};
      if (before === undefined) {
        if (snapshot[section][key] === undefined) {
          snapshot[section][key] = value;
          changed = true;
        }
      } else if (section === 'tables' && snapshot[section][key]) {
        for (const part of TABLE_PARTS) {
          for (const [name, item] of Object.entries(value[part] ?? {})) {
            if (before[part]?.[name] !== undefined) continue;
            snapshot[section][key][part] ??= {};
            if (snapshot[section][key][part][name] === undefined) {
              snapshot[section][key][part][name] = item;
              changed = true;
            }
          }
        }
      }
    }
  }
  return changed;
}

/**
 * @param {{root: string, base?: string, mainJournal?: object, log?: (s: string) => void}} options
 * root is the repository root; mainJournal overrides reading it from `base`.
 * Returns {renamed: [{from, to}], references: [{file, from, to}], changed}.
 */
export function renumber({ root, base = 'origin/HEAD', mainJournal, log = console.log }) {
  const rel = 'apps/server/drizzle';
  const dir = join(root, rel);
  const meta = join(dir, 'meta');
  const journalFile = join(meta, '_journal.json');

  if (!mainJournal) {
    const text = gitShow(root, base, `${rel}/meta/_journal.json`);
    if (!text) throw new Error(`Can't read ${rel}/meta/_journal.json from ${base}; pass the base ref.`);
    mainJournal = JSON.parse(text);
  }
  const mainTags = new Set(mainJournal.entries.map((e) => e.tag));
  const mainLatestWhen = Math.max(0, ...mainJournal.entries.map((e) => e.when));
  const mainMaxNum = Math.max(-1, ...mainJournal.entries.map((e) => num(e.tag)));

  // The branch's own migrations: SQL files main's journal doesn't know, in journal order where
  // the working journal knows them, otherwise by number then name.
  const text = existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : '';
  const journal = text && !text.includes('<<<<<<<') ? JSON.parse(text) : { ...mainJournal };
  const known = new Map(journal.entries.map((e, i) => [e.tag, { entry: e, i }]));
  const own = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.slice(0, -4))
    .filter((tag) => !mainTags.has(tag))
    .sort((a, b) => (known.get(a)?.i ?? 1e9) - (known.get(b)?.i ?? 1e9) || a.localeCompare(b));

  // Snapshots, read before anything moves. A snapshot at a number main also uses may have been
  // resolved to main's side, so then take the branch's from the merge's first parent.
  const mainSnapshotText = (n) => gitShow(root, base, `${rel}/meta/${pad(n)}_snapshot.json`);
  const snapshotOf = (tag) => {
    const path = `${rel}/meta/${pad(num(tag))}_snapshot.json`;
    const file = join(root, path);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const isMains = current !== null && current === mainSnapshotText(num(tag));
    if (current !== null && !isMains && !current.includes('<<<<<<<')) return JSON.parse(current);
    for (const ref of ['HEAD^1', 'HEAD']) {
      const old = gitShow(root, ref, path);
      if (old && old !== mainSnapshotText(num(tag))) return JSON.parse(old);
    }
    throw new Error(`No snapshot found for ${tag} (${path}).`);
  };

  const result = { renamed: [], references: [], changed: false };
  if (own.length === 0) {
    log('No branch migrations to renumber.');
    return result;
  }

  const snapshots = own.map(snapshotOf);
  const mainLatestSnapshot = readJson(join(meta, `${pad(mainMaxNum)}_snapshot.json`));
  const startId = snapshots[0].prevId;
  const baseSnapshot = readdirSync(meta)
    .filter((f) => f.endsWith('_snapshot.json'))
    .map((f) => readJson(join(meta, f)))
    .find((s) => s.id === startId);

  // Rename: SQL and snapshot of each, in order. Two passes so clashing numbers never overwrite.
  const targets = own.map((tag, i) => `${pad(mainMaxNum + 1 + i)}${tag.slice(4)}`);
  const moves = own.map((tag, i) => [tag, targets[i]]).filter(([from, to]) => from !== to);
  const staged = moves.map(([from, to], i) => ({ from, to, tmp: `.renumber-${i}` }));
  const oldSnapshotPaths = new Set(own.map((t) => `${pad(num(t))}_snapshot.json`));
  const mainOwnsPath = (name) => mainTags.size > 0 && [...mainTags].some((t) => `${pad(num(t))}_snapshot.json` === name);
  for (const { from, tmp } of staged) {
    move(root, `${rel}/${from}.sql`, `${rel}/${tmp}.sql`);
    const snap = `${rel}/meta/${pad(num(from))}_snapshot.json`;
    const name = `${pad(num(from))}_snapshot.json`;
    if (oldSnapshotPaths.has(name) && !mainOwnsPath(name) && existsSync(join(root, snap))) {
      move(root, snap, `${rel}/meta/${tmp}_snapshot.json`);
    } else if (existsSync(join(root, snap))) {
      // main's snapshot at a clashing number stays where it is.
    }
  }
  for (const { from, to, tmp } of staged) {
    move(root, `${rel}/${tmp}.sql`, `${rel}/${to}.sql`);
    result.renamed.push({ from, to });
    log(`renamed ${from} -> ${to}`);
  }

  // Snapshots: rechain and fold main's additions, written at the new numbers.
  let prevId = mainLatestSnapshot.id;
  snapshots.forEach((snapshot, i) => {
    if (baseSnapshot) fold(snapshot, baseSnapshot, mainLatestSnapshot);
    snapshot.prevId = prevId;
    prevId = snapshot.id;
    const file = join(meta, `${pad(mainMaxNum + 1 + i)}_snapshot.json`);
    for (const { tmp } of staged) rmSync(join(meta, `${tmp}_snapshot.json`), { force: true });
    writeJson(file, snapshot);
  });

  // Journal: main's entries untouched, then the branch's, with `when` above main's latest.
  let when = mainLatestWhen;
  const entries = mainJournal.entries.map((e) => ({ ...e }));
  own.forEach((tag, i) => {
    const old = known.get(tag)?.entry;
    when = old && old.when > when ? old.when : when + WHEN_STEP;
    entries.push({
      idx: entries.length,
      version: old?.version ?? mainJournal.entries.at(-1)?.version ?? '7',
      when,
      tag: targets[i],
      breakpoints: old?.breakpoints ?? true,
    });
  });
  const next = { ...mainJournal, entries };
  writeJson(journalFile, next);
  result.changed = moves.length > 0 || JSON.stringify(journal) !== JSON.stringify(next);

  // References in the server's tests.
  const testDir = join(root, 'apps/server/test');
  if (existsSync(testDir) && moves.length > 0) {
    for (const f of readdirSync(testDir, { recursive: true })) {
      const file = join(testDir, f);
      if (!/\.(ts|mjs|js|sql|json)$/.test(f) || !existsSync(file)) continue;
      let content;
      try { content = readFileSync(file, 'utf8'); } catch { continue; }
      let updated = content;
      for (const { from, to } of staged) {
        if (updated.includes(from)) {
          updated = updated.split(from).join(to);
          result.references.push({ file: `apps/server/test/${f}`, from, to });
          log(`updated ${from} -> ${to} in apps/server/test/${f}`);
        }
      }
      if (updated !== content) writeFileSync(file, updated);
    }
  }
  if (moves.length > 0) {
    log(
      '\nIf a shared dev database already ran the branch\'s old numbers: a migration from main with a ' +
      'lower `when` than one already run will be skipped, so apply its SQL by hand or `scripts/dev.sh restore`.',
    );
  } else {
    log('Migrations already renumbered; nothing to rename.');
  }
  return result;
}

// drizzle-kit must see no drift; anything it generates is deleted and the run fails.
export function driftCheck({ root, log = console.log }) {
  const dir = join(root, 'apps/server/drizzle');
  const list = () => readdirSync(dir, { recursive: true }).map(String).sort();
  const before = new Set(list());
  const journalFile = join(dir, 'meta/_journal.json');
  const journalBefore = readFileSync(journalFile, 'utf8');
  const run = spawnSync('npx', ['drizzle-kit', 'generate', '--name', 'drift_check'], {
    cwd: join(root, 'apps/server'),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--conditions=development' },
  });
  const output = `${run.stdout}${run.stderr}`;
  const generated = list().filter((f) => !before.has(f));
  for (const f of generated) rmSync(join(dir, f), { force: true, recursive: true });
  writeFileSync(journalFile, journalBefore);
  if (generated.length > 0 || run.status !== 0) {
    log(output);
    throw new Error(
      generated.length > 0
        ? `drizzle-kit found schema drift (deleted ${generated.join(', ')}): the folded snapshots miss changes; fix them by hand.`
        : 'drizzle-kit generate failed.',
    );
  }
  log('drizzle-kit reports no schema changes.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), '../..');
  try {
    renumber({ root, base: process.argv[2] || 'origin/HEAD' });
    driftCheck({ root });
  } catch (error) {
    console.error(`renumber-migrations failed: ${error.message}`);
    process.exit(1);
  }
}
