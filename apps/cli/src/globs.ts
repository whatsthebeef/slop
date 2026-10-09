import { z } from 'zod';
import type { Settings } from './config.js';
import { SlopError, UsageError } from './errors.js';
import type { Git } from './git.js';
import type { ToolCaller } from './init.js';
import { describeError } from './util.js';

/** What the glob commands need from the outside world; tests inject fakes. */
export interface GlobDeps {
  readonly client: ToolCaller;
  readonly git: Git;
  /** The enclosing git checkout's root, or undefined outside one. */
  readonly root: string | undefined;
  readonly settings: Settings;
  readonly stdout: (text: string) => void;
  readonly log: (message: string) => void;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly newIdempotencyKey: () => string;
}

export const GLOB_USAGE = 'glob <id> [--json]';
export const PICK_UP_USAGE = 'pick-up <id> [--take-over] [--env <name>] [--json]';
export const NEW_USAGE =
  'new [--same|--sub|--super] [--feature|--task|--bug] [--routine] [--env <name>] [--after <id>[,<id>...]] [--json] <prompt...>';
export const READY_USAGE = 'ready [<id>] [--json]';
export const MERGE_USAGE = 'merge [<id>] [--continue] [--json]';

/** How long pick-up waits for the glob's branch. */
export const PROVISION_TIMEOUT_MS = 60_000;
const FIRST_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 8_000;

// Glob IDs as slop formats them (s1t4); also keeps an ID from reaching git as an option.
const GLOB_ID = /^s[1-9]\d*[ftbh][1-9]\d*$/;

const LIVE_RUN_STATES: ReadonlySet<string> = new Set(['queued', 'active', 'watching']);
const MERGED_STATUSES: ReadonlySet<string> = new Set(['reviewing', 'signed_off']);

const runSchema = z.object({
  id: z.string(),
  state: z.string(),
  routineOwner: z.string().optional(),
  sessionUrl: z.string().nullable().optional(),
});

const prSchema = z.object({ number: z.number(), state: z.string() });

/** The part of slop's glob view the commands use (get_glob, pick_up and merge all return it). */
const globSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  category: z.string(),
  status: z.string(),
  version: z.number().int(),
  branch: z.string(),
  implementer: z.string().nullable(),
  provisioning: z.string(),
  environment: z.string().nullable().default(null),
  pr: prSchema.nullable(),
  currentRun: runSchema.nullable(),
});

type GlobView = z.infer<typeof globSchema>;

const createdSchema = z.object({
  id: z.string(),
  branch: z.string(),
  type: z.string(),
  category: z.string(),
  status: z.string(),
  provisioning: z.string(),
  after: z.array(z.string()).optional(),
  waiting: z.boolean().optional(),
});

const markedReadySchema = z.object({ id: z.string(), status: z.string(), pr: prSchema.nullable() });

interface ParsedArgs {
  readonly flags: ReadonlySet<string>;
  /** Options that take a value (`--env dev` or `--env=dev`). */
  readonly values: ReadonlyMap<string, string>;
  readonly positionals: readonly string[];
}

/**
 * Splits flags from positionals; a flag outside `allowed` (or `valued`, for options that take a
 * value) is a usage error.
 */
function parseArgs(
  args: readonly string[],
  allowed: readonly string[],
  usage: string,
  valued: readonly string[] = [],
): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg : arg.slice(0, eq);
      if (valued.includes(name)) {
        const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
        if (value === undefined || value === '' || value.startsWith('--'))
          throw new UsageError(`${name} needs a value\nusage: slop ${usage}`);
        // --after may be repeated; the IDs add up.
        const earlier = values.get(name);
        values.set(name, name === '--after' && earlier !== undefined ? `${earlier},${value}` : value);
        continue;
      }
      if (!allowed.includes(arg))
        throw new UsageError(`unknown option ${arg}\nusage: slop ${usage}`);
      flags.add(arg);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, values, positionals };
}

function requireGlobId(id: string, usage: string): string {
  if (!GLOB_ID.test(id))
    throw new UsageError(`'${id}' is not a glob ID (like s1t4)\nusage: slop ${usage}`);
  return id;
}

function requireRoot(deps: GlobDeps, command: string): string {
  if (deps.root === undefined) throw new SlopError(`${command}: run this inside a git checkout`);
  return deps.root;
}

/** The ID given, or the checked-out branch (a glob's branch is its ID). */
async function globIdOrBranch(
  deps: GlobDeps,
  positionals: readonly string[],
  command: string,
  usage: string,
): Promise<string> {
  if (positionals.length > 1) throw new UsageError(`usage: slop ${usage}`);
  const given = positionals[0];
  if (given !== undefined) return requireGlobId(given, usage);
  const branch = await deps.git.currentBranch(requireRoot(deps, command));
  if (branch === undefined || !GLOB_ID.test(branch)) {
    throw new UsageError(
      `${command}: the current branch (${branch ?? 'detached HEAD'}) is not a glob; pass the glob ID`,
    );
  }
  return branch;
}

function parseGlob(value: unknown, tool: string): GlobView {
  const parsed = globSchema.safeParse(value);
  if (!parsed.success) throw new SlopError(`${tool}: unexpected response from slop`);
  // A glob's branch is its ID. The branch reaches git (and sstor's `git worktree add`), so a
  // value that isn't one is refused rather than risk it being read as an option.
  const { id, branch } = parsed.data;
  if (!GLOB_ID.test(id) || branch !== id) {
    throw new SlopError(`${tool}: slop returned branch '${branch}' for glob '${id}'`);
  }
  return parsed.data;
}

async function getGlob(deps: GlobDeps, id: string): Promise<GlobView> {
  return parseGlob(await deps.client.call('get_glob', { id }), 'get_glob');
}

function liveRun(glob: GlobView): GlobView['currentRun'] {
  const run = glob.currentRun;
  return run !== null && LIVE_RUN_STATES.has(run.state) ? run : null;
}

function summary(glob: GlobView): Record<string, unknown> {
  return {
    id: glob.id,
    title: glob.title,
    type: glob.type,
    category: glob.category,
    status: glob.status,
    version: glob.version,
    branch: glob.branch,
    implementer: glob.implementer,
    provisioning: glob.provisioning,
    environment: glob.environment,
    currentRun: glob.currentRun,
    pr: glob.pr,
  };
}

function describeGlob(glob: GlobView): string {
  const run =
    glob.currentRun === null ? 'none' : `${glob.currentRun.state} (${glob.currentRun.id})`;
  const pr = glob.pr === null ? 'none' : `#${glob.pr.number} ${glob.pr.state}`;
  return (
    `${glob.id} [${glob.type} ${glob.category}] ${glob.status}: ${glob.title}` +
    ` (branch ${glob.branch}; ${glob.environment === null ? '' : `environment ${glob.environment}; `}` +
    `implementer ${glob.implementer ?? 'none'}; run ${run}; PR ${pr})`
  );
}

function printJson(deps: GlobDeps, value: unknown): void {
  deps.stdout(`${JSON.stringify(value)}\n`);
}

/** `slop glob <id>`: the glob's summary. */
export async function globCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { flags, positionals } = parseArgs(args, ['--json'], GLOB_USAGE);
  const [id] = positionals;
  if (id === undefined || positionals.length !== 1)
    throw new UsageError(`usage: slop ${GLOB_USAGE}`);
  const glob = await getGlob(deps, requireGlobId(id, GLOB_USAGE));
  if (flags.has('--json')) printJson(deps, summary(glob));
  else deps.stdout(`${describeGlob(glob)}\n`);
}

/**
 * `slop pick-up <id>`: become the implementer and wait for the branch. A queued, active or
 * watching run is refused without --take-over; pick_up is always called, since slop treats
 * re-picking your own glob as a no-op (and it moves your own failed glob back to in_progress).
 */
export async function pickUpCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { flags, values, positionals } = parseArgs(args, ['--take-over', '--json'], PICK_UP_USAGE, [
    '--env',
  ]);
  const [given] = positionals;
  if (given === undefined || positionals.length !== 1)
    throw new UsageError(`usage: slop ${PICK_UP_USAGE}`);
  const id = requireGlobId(given, PICK_UP_USAGE);
  const takeOver = flags.has('--take-over');
  const environment = values.get('--env');

  const glob = await getGlob(deps, id);
  if (MERGED_STATUSES.has(glob.status))
    throw new SlopError(`${id} is already merged (${glob.status})`);
  const run = liveRun(glob);
  if (run !== null && !takeOver) {
    const owner = run.routineOwner === undefined ? '' : ` (owner ${run.routineOwner})`;
    const watch = run.sessionUrl ?? 'the glob view';
    throw new SlopError(
      `${id} has a routine run ${run.state}${owner}. Use --take-over to supersede it, or watch it: ${watch}`,
    );
  }
  // slop refuses a take-over when there is no run to take over, so only ask for one when there is.
  const picked = parseGlob(
    await deps.client.call('pick_up', {
      id,
      version: glob.version,
      ...(takeOver && run !== null ? { takeOver: true } : {}),
      ...(environment === undefined ? {} : { environment }),
    }),
    'pick_up',
  );
  const ready = await waitForBranch(deps, picked);
  deps.log(`slop: picked up ${ready.id} (${ready.status})`);
  if (flags.has('--json')) printJson(deps, summary(ready));
  else deps.stdout(`${ready.branch}\n`);
}

/** Polls get_glob with backoff until provisioning is ok and origin has the branch. */
async function waitForBranch(deps: GlobDeps, first: GlobView): Promise<GlobView> {
  const deadline = deps.now() + PROVISION_TIMEOUT_MS;
  let glob = first;
  let delay = FIRST_POLL_DELAY_MS;
  let lastGitError: string | undefined;
  for (;;) {
    if (glob.provisioning === 'failed') {
      throw new SlopError(`${glob.id}: slop could not create its branch; check the glob view`);
    }
    if (glob.provisioning === 'ok') {
      // Outside a checkout there is no origin to ask; slop's provisioning state has to do.
      if (deps.root === undefined) return glob;
      try {
        if (await deps.git.remoteBranchExists(deps.root, glob.branch)) return glob;
        lastGitError = undefined;
      } catch (error) {
        // A transient failure (network) counts as "not yet" until the deadline.
        lastGitError = describeError(error);
      }
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      const cause = lastGitError === undefined ? '' : ` (last git error: ${lastGitError})`;
      throw new SlopError(
        `${glob.id} has no branch yet (provisioning: ${glob.provisioning}); check the glob view${cause}`,
      );
    }
    await deps.sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
    glob = await getGlob(deps, glob.id);
  }
}

const TYPE_FLAGS = { '--same': 'same', '--sub': 'sub', '--super': 'super' } as const;
const CATEGORY_FLAGS = { '--feature': 'feature', '--task': 'task', '--bug': 'bug' } as const;

/** The value of the one flag from `table` that was given, or undefined; two is a usage error. */
function oneOf<T extends string>(
  flags: ReadonlySet<string>,
  table: Readonly<Record<string, T>>,
): T | undefined {
  const given = Object.keys(table).filter((flag) => flags.has(flag));
  if (given.length > 1) throw new UsageError(`pass only one of ${given.join(', ')}`);
  const [flag] = given;
  return flag === undefined ? undefined : table[flag];
}

function boardSetting(settings: Settings): number {
  const board = settings.SLOP_BOARD;
  if (board === undefined || !/^[1-9]\d*$/.test(board)) {
    throw new UsageError('no board: set SLOP_BOARD, or add SLOP_BOARD to .sstor/sstor.conf');
  }
  return Number(board);
}

/** `slop new`: create a glob through intake on the configured board. */
export async function newCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { flags, values, positionals } = parseArgs(
    args,
    [...Object.keys(TYPE_FLAGS), ...Object.keys(CATEGORY_FLAGS), '--routine', '--json'],
    NEW_USAGE,
    ['--env', '--after'],
  );
  const environment = values.get('--env');
  const after = (values.get('--after') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  for (const id of after) requireGlobId(id, NEW_USAGE);
  const type = oneOf(flags, TYPE_FLAGS);
  const category = oneOf(flags, CATEGORY_FLAGS);
  const routine = flags.has('--routine');
  if (routine && type !== undefined && type !== 'same') {
    throw new UsageError('--routine starts a routine on a same; a sub always gets one');
  }
  const prompt = positionals.join(' ').trim();
  if (prompt === '') throw new UsageError(`usage: slop ${NEW_USAGE}`);

  const created = createdSchema.safeParse(
    await deps.client.call('create_glob', {
      board: boardSetting(deps.settings),
      idempotencyKey: deps.newIdempotencyKey(),
      input: prompt,
      ...(type === undefined ? {} : { type }),
      ...(category === undefined ? {} : { category }),
      ...(routine ? { autoTrigger: true } : {}),
      ...(environment === undefined ? {} : { environment }),
      ...(after.length === 0 ? {} : { after }),
    }),
  );
  if (!created.success) throw new SlopError('create_glob: unexpected response from slop');
  const glob = created.data;
  // A sub, or a same created with --routine, is queued for a routine at once.
  const routineWillImplement = glob.status === 'implementing';
  if (flags.has('--json')) {
    printJson(deps, {
      id: glob.id,
      branch: glob.branch,
      type: glob.type,
      category: glob.category,
      status: glob.status,
      routine: routineWillImplement,
      waiting: glob.waiting === true,
      after: glob.after ?? [],
    });
    return;
  }
  const who = glob.waiting === true
    ? `waiting for ${(glob.after ?? []).join(', ')} to merge, then a routine will implement it`
    : routineWillImplement
      ? 'a routine will implement it'
      : 'pick it up to implement it';
  deps.stdout(
    `${glob.id} [${glob.type} ${glob.category}] ${glob.status}: branch ${glob.branch}; ${who}\n`,
  );
}

// Untracked paths `slop init`, sstor and the agents leave in a worktree; not worth a warning.
const EXPECTED_UNTRACKED = ['.claude/', 'CLAUDE.md', '.reviews/', '.sstor/'];

function isUnexpectedUntracked(path: string): boolean {
  return !EXPECTED_UNTRACKED.some((prefix) =>
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix,
  );
}

/**
 * `slop ready [<id>]`: push the branch and mark the glob's PR ready. A glob already in pr_open
 * with a ready PR is pushed and counts as done.
 */
export async function readyCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { flags, positionals } = parseArgs(args, ['--json'], READY_USAGE);
  const root = requireRoot(deps, 'ready');
  const id = await globIdOrBranch(deps, positionals, 'ready', READY_USAGE);
  // The checks below look at this worktree, so it must be the glob's branch that is pushed.
  const current = await deps.git.currentBranch(root);
  if (current !== id) {
    throw new SlopError(
      `ready: ${id} is not the checked-out branch (${current ?? 'detached HEAD'}); run it in ${id}'s worktree`,
    );
  }
  if (await deps.git.hasUncommittedChanges(root)) {
    throw new SlopError(
      'ready: the working tree has uncommitted changes; commit or stash them first',
    );
  }
  const untracked = (await deps.git.untrackedFiles(root)).filter(isUnexpectedUntracked);
  if (untracked.length > 0) {
    deps.log(
      `slop: warning: untracked files are not pushed (git add them if they belong in the PR): ${untracked.join(', ')}`,
    );
  }
  const glob = await getGlob(deps, id);
  if (MERGED_STATUSES.has(glob.status))
    throw new SlopError(`${id} is already merged (${glob.status})`);
  if (glob.status === 'merging')
    throw new SlopError(`${id} is being merged; nothing to mark ready`);
  await deps.git.push(root, id);
  const alreadyReady = glob.status === 'pr_open' && glob.pr?.state === 'ready';
  let result = { id, status: glob.status, pr: glob.pr };
  if (!alreadyReady) {
    const marked = markedReadySchema.safeParse(await deps.client.call('mark_ready', { id }));
    if (!marked.success) throw new SlopError('mark_ready: unexpected response from slop');
    result = marked.data;
  }
  if (flags.has('--json')) {
    printJson(deps, { ...result, alreadyReady });
    return;
  }
  deps.stdout(
    alreadyReady
      ? `${id}: pushed; the PR was already ready for review\n`
      : `${id}: pushed and marked ready for review (pr_open once GitHub confirms)\n`,
  );
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof SlopError && error.message.startsWith('version_conflict:');
}

/**
 * Calls `merge` with the version read. A webhook can change the glob between the read and the
 * merge, so a version conflict is retried once with a fresh read; the write stays conditional.
 * `continueAfter` is a super's Merge and continue.
 */
async function mergeAt(deps: GlobDeps, glob: GlobView, continueAfter: boolean): Promise<GlobView> {
  const attempt = async (version: number): Promise<GlobView> =>
    parseGlob(
      await deps.client.call('merge', { id: glob.id, version, ...(continueAfter ? { continue: true } : {}) }),
      'merge',
    );
  try {
    return await attempt(glob.version);
  } catch (error) {
    if (!isVersionConflict(error)) throw error;
    const fresh = await getGlob(deps, glob.id);
    // A continued merge returns the glob to in_progress, so only a PR still open is retried.
    const done = continueAfter ? fresh.status !== 'pr_open' : MERGED_STATUSES.has(fresh.status);
    return done ? fresh : attempt(fresh.version);
  }
}

/**
 * `slop merge [<id>] [--continue]`: merge through slop, as the glob's Merge button does; with
 * --continue, a super's Merge and continue (it stays in progress and gets a new PR on the next push).
 */
export async function mergeCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { flags, positionals } = parseArgs(args, ['--json', '--continue'], MERGE_USAGE);
  const id = await globIdOrBranch(deps, positionals, 'merge', MERGE_USAGE);
  const continueAfter = flags.has('--continue');
  const glob = await getGlob(deps, id);
  const merged = MERGED_STATUSES.has(glob.status) ? glob : await mergeAt(deps, glob, continueAfter);
  if (flags.has('--json')) {
    printJson(deps, summary(merged));
    return;
  }
  const note =
    merged.status === 'merging'
      ? `slop is updating the branch, rerunning checks and squash-merging${continueAfter ? '; the glob then stays in progress' : ''}`
      : MERGED_STATUSES.has(merged.status)
        ? 'merged'
        : continueAfter && merged.status === 'in_progress'
          ? 'merged and continued; the next push opens a new draft PR'
          : 'see the glob view';
  deps.stdout(`${id}: ${merged.status} (${note})\n`);
}
