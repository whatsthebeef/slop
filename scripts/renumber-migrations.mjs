#!/usr/bin/env node
// Renumbers a branch's Drizzle migrations after merging main (scripts/dev.sh renumber-migrations).
//
// Two globs that add a migration off the same base both claim the next number. In a checkout that
// has merged main, this keeps main's migrations exactly as they are and moves the branch's own to
// the next free numbers, in their original order: files renamed with `git mv`, journal rebuilt with
// `when` above main's latest, snapshots rechained and given main's schema changes (a three-way merge
// of each snapshot), references in apps/server/test updated. It ends with a drizzle-kit drift check.
// Running it again changes nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const JOURNAL = 'meta/_journal.json';
const WHEN_STEP = 1000; // the hand-set gaps between journal times, as the build doc recommends

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pad = (n) => String(n).padStart(4, '0');
const snapshotName = (tag) => `meta/${tag.slice(0, 4)}_snapshot.json`;
const json = (value) => JSON.stringify(value, null, 2);

// Three-way merge of snapshot JSON: what the branch changed from `base` wins, what main changed
// (`theirs`) is kept where the branch left it alone. Arrays and scalars are leaves.
export function merge3(base, ours, theirs) {
  if (same(ours, base)) return theirs;
  if (same(theirs, base)) return ours;
  if (!isObject(ours) || !isObject(theirs)) return ours;
  const baseObject = isObject(base) ? base : {};
  const result = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(baseObject)])) {
    const merged = merge3(baseObject[key], ours[key], theirs[key]);
    if (merged !== undefined) result[key] = merged;
  }
  return result;
}

/**
 * @param {object} options
 * @param {string} options.drizzleDir        the checkout's apps/server/drizzle
 * @param {object} options.mainJournal       main's parsed journal
 * @param {(name: string) => string | null} options.mainFile   main's copy of a file under drizzleDir
 * @param {object} options.branchJournal     the branch's journal (before the merge)
 * @param {(name: string) => string | null} options.branchSnapshot  the branch's own copy of a snapshot
 * @param {(from: string, to: string) => void} options.move    git mv (or a plain rename)
 * @param {(path: string) => void} options.stage               git add (or nothing)
 * @param {string | null} [options.testDir]  where to rewrite references to renamed tags
 */
export function renumber({ drizzleDir, mainJournal, mainFile, branchJournal, branchSnapshot, move, stage, testDir = null }) {
  const path = (name) => join(drizzleDir, name);
  const write = (name, text) => {
    mkdirSync(dirname(path(name)), { recursive: true });
    writeFileSync(path(name), text);
    stage(path(name));
  };
  const mainTags = new Set(mainJournal.entries.map((e) => e.tag));
  const mainNumber = Math.max(-1, ...mainJournal.entries.map((e) => Number.parseInt(e.tag, 10)));
  const mainLatest = Math.max(0, ...mainJournal.entries.map((e) => e.when));
  const own = branchJournal.entries.filter((e) => !mainTags.has(e.tag));

  // Targets, in the branch's original order, and the new journal times above main's latest.
  let when = mainLatest;
  const plan = own.map((entry, i) => {
    when = Math.max(entry.when, when + WHEN_STEP);
    const tag = `${pad(mainNumber + 1 + i)}_${entry.tag.replace(/^\d+_/, '')}`;
    return { entry, from: entry.tag, tag, when };
  });

  // The branch's snapshots, read before any file moves (a clash leaves main's at the same name).
  const originals = plan.map(({ from }) => {
    const text = branchSnapshot(snapshotName(from));
    return text === null ? null : JSON.parse(text);
  });

  // Main's snapshots, to find the one the branch was based on and the latest.
  const mainSnapshots = mainJournal.entries.map((e) => JSON.parse(mainFile(snapshotName(e.tag)) ?? 'null')).filter(Boolean);
  const mainLast = mainSnapshots[mainSnapshots.length - 1] ?? null;

  const renamed = [];
  // Highest number first, so a target is never a name that is still waiting to move.
  for (const step of [...plan].reverse()) {
    if (step.from !== step.tag) {
      move(path(`${step.from}.sql`), path(`${step.tag}.sql`));
      renamed.push(`${step.from} -> ${step.tag}`);
    }
    const oldSnapshot = snapshotName(step.from);
    const newSnapshot = snapshotName(step.tag);
    if (oldSnapshot !== newSnapshot) {
      const mainCopy = mainFile(oldSnapshot);
      if (mainCopy === null) {
        if (existsSync(path(oldSnapshot))) move(path(oldSnapshot), path(newSnapshot));
      } else {
        // main owns that name: put main's snapshot back below.
        write(oldSnapshot, mainCopy);
      }
    }
  }

  // Rechain, folding main's schema changes into each snapshot as it goes.
  let previous = mainLast;
  let previousOriginal = null;
  plan.forEach((step, i) => {
    const original = originals[i];
    if (original === null) return;
    const base = i === 0 ? mainSnapshots.find((s) => s.id === original.prevId) ?? null : previousOriginal;
    const merged = base !== null && previous !== null ? merge3(base, original, previous) : original;
    const next = { ...merged, id: original.id, prevId: previous ? previous.id : original.prevId };
    write(snapshotName(step.tag), json(next));
    previous = next;
    previousOriginal = original;
  });

  // Main's journal entries exactly, then the branch's.
  const journal = {
    ...mainJournal,
    entries: [
      ...mainJournal.entries,
      ...plan.map((step, i) => ({ ...step.entry, idx: mainJournal.entries.length + i, when: step.when, tag: step.tag })),
    ],
  };
  const journalText = json(journal);
  const journalChanged = !existsSync(path(JOURNAL)) || readFileSync(path(JOURNAL), 'utf8') !== journalText;
  if (journalChanged) write(JOURNAL, journalText);

  // References in the tests to the old tags.
  const references = [];
  const changed = plan.filter((s) => s.from !== s.tag);
  if (testDir && changed.length > 0 && existsSync(testDir)) {
    const byOld = new Map(changed.map((s) => [s.from, s.tag]));
    const pattern = new RegExp([...byOld.keys()].join('|'), 'g');
    for (const file of readdirSync(testDir, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !/\.[cm]?[jt]sx?$/.test(file.name)) continue;
      const full = join(file.parentPath, file.name);
      const text = readFileSync(full, 'utf8');
      if (!pattern.test(text)) continue;
      pattern.lastIndex = 0;
      writeFileSync(full, text.replace(pattern, (old) => byOld.get(old)));
      stage(full);
      references.push(full);
    }
  }
  return { renamed, references, journalChanged };
}

// ---- CLI ----

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitOrNull = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

function resolveBase(repo, argument) {
  if (argument) return argument;
  const head = gitOrNull(repo, 'rev-parse', '--abbrev-ref', 'origin/HEAD');
  if (head) return head.trim();
  return 'origin/main';
}

function driftCheck(serverDir, drizzleDir) {
  const journalPath = join(drizzleDir, JOURNAL);
  const journalBefore = readFileSync(journalPath, 'utf8');
  const filesBefore = new Set(readdirSync(drizzleDir, { recursive: true }));
  let output = '';
  try {
    output = execFileSync('npx', ['drizzle-kit', 'generate', '--name', 'drift_check'], {
      cwd: serverDir,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=development`.trim() },
    });
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const clean = /no schema changes/i.test(output);
  if (!clean) {
    for (const file of readdirSync(drizzleDir, { recursive: true })) {
      if (!filesBefore.has(file) && /\.(sql|json)$/.test(file)) rmSync(join(drizzleDir, file), { force: true });
    }
    writeFileSync(journalPath, journalBefore);
    console.error(output.trim());
    console.error('\nFAILED: drizzle-kit still sees schema changes after renumbering (generated files removed).');
    console.error('A snapshot is missing something main or the branch changed; fix it by hand or regenerate.');
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf('--base');
  const baseArgument = baseIndex >= 0 ? args[baseIndex + 1] : args.find((a) => !a.startsWith('--'));
  const skipCheck = args.includes('--no-check');
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = git(resolve(here, '..'), 'rev-parse', '--show-toplevel').trim();
  const serverDir = join(repo, 'apps/server');
  const drizzleDir = join(serverDir, 'drizzle');
  const inRepo = (name) => relative(repo, join(drizzleDir, name));
  const base = resolveBase(repo, baseArgument);

  const mainJournalText = gitOrNull(repo, 'show', `${base}:${inRepo(JOURNAL)}`);
  if (mainJournalText === null) {
    console.error(`Can't read ${inRepo(JOURNAL)} from ${base}. Pass the base: scripts/dev.sh renumber-migrations <ref>`);
    process.exit(1);
  }
  const mainFile = (name) => gitOrNull(repo, 'show', `${base}:${inRepo(name)}`);

  // The branch's side of every file: the working copy unless it is conflicted or main's own;
  // then the index's "ours" or the first parent of the merge.
  const branchSide = (name) => {
    const sources = [
      () => (existsSync(join(drizzleDir, name)) ? readFileSync(join(drizzleDir, name), 'utf8') : null),
      () => gitOrNull(repo, 'show', `:2:${inRepo(name)}`),
      () => gitOrNull(repo, 'show', `HEAD^1:${inRepo(name)}`),
    ];
    return sources;
  };
  const mainJournal = JSON.parse(mainJournalText);
  const [workingJournal, oursJournal, parentJournal] = branchSide(JOURNAL).map((read) => read());
  const parse = (text) => {
    try {
      return text === null ? null : JSON.parse(text);
    } catch {
      return null;
    }
  };
  const mainTags = new Set(mainJournal.entries.map((e) => e.tag));
  // The first candidate that still has the branch's own entries.
  const branchJournal = [workingJournal, oursJournal, parentJournal]
    .map(parse)
    .filter((j) => j !== null)
    .find((j) => j.entries.some((e) => !mainTags.has(e.tag))) ?? mainJournal;

  const branchSnapshot = (name) => {
    const [working, ours, parent] = branchSide(name).map((read) => read());
    const mainCopy = mainFile(name);
    // A working copy equal to main's, or with merge markers, isn't the branch's.
    if (working !== null && working !== mainCopy && !working.includes('<<<<<<<')) return working;
    return ours ?? parent ?? (mainCopy === null ? working : null);
  };

  const result = renumber({
    drizzleDir,
    mainJournal,
    mainFile,
    branchJournal,
    branchSnapshot,
    move: (from, to) => git(repo, 'mv', '-f', from, to),
    stage: (file) => git(repo, 'add', '--', file),
    testDir: join(serverDir, 'test'),
  });

  if (result.renamed.length === 0 && !result.journalChanged) {
    console.log('Nothing to renumber: the branch\'s migrations already follow main\'s.');
  } else {
    for (const line of result.renamed) console.log(`Renamed ${line}`);
    console.log('Rebuilt the journal and rechained the snapshots.');
  }
  for (const file of result.references) console.log(`Updated migration references in ${relative(repo, file)}`);
  if (result.renamed.length > 0) {
    console.log(
      '\nIf a shared dev database has already run the branch\'s old numbers: a migration from main with a\n' +
        'lower `when` than one already run will be skipped. Apply its SQL by hand, or `scripts/dev.sh restore`.',
    );
  }
  if (!skipCheck) {
    driftCheck(serverDir, drizzleDir);
    console.log('drizzle-kit reports no schema changes.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
// kept for tests that use plain renames instead of git
export const plainMove = (from, to) => renameSync(from, to);
