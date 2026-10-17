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
  settings: Settings;
  readonly stdout: (text: string) => void;
  readonly log: (message: string) => void;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly newIdempotencyKey: () => string;
  /** Asks a question on the terminal and resolves to the answer; undefined when nobody can answer (no TTY). */
  readonly ask?: (question: string) => Promise<string>;
}

export const GLOB_USAGE = 'glob <id> [--json]';
export const HANDOVER_USAGE = 'handover <id> [--json]';
export const PICK_UP_USAGE = 'pick-up <id> [--take-over] [--env <name>] [--json]';
export const NEW_USAGE =
  'new [--mode sub|same|super | --same|--sub|--super] [--fix] [--routine] [--env <name>] [--after <id>[,<id>...]] [--action [--prepare [--record branch|artifact|attachment]]] [--json] <prompt...>';
export const READY_USAGE = 'ready [<id>] [--json]';
export const DELETE_USAGE = 'delete <id> [--reason <text>] [--yes] [--json]';
export const MERGE_USAGE = 'merge [<id>] [--continue] [--json]';
export const REOPEN_USAGE = 'reopen <id> --reason <text> [--json]';

/** How long pick-up waits for the glob's branch. */
export const PROVISION_TIMEOUT_MS = 60_000;
const FIRST_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 8_000;

// Glob IDs as slop formats them (s1t4); also keeps an ID from reaching git as an option. Mirrors GLOB_ID_PATTERN in
// packages/core/src/domain/ids.ts (the CLI doesn't depend on @slop/core).
export const GLOB_ID = /^s[1-9]\d*[ftbhka][1-9]\d*$/;

export const LIVE_RUN_STATES: ReadonlySet<string> = new Set(['queued', 'active', 'watching']);
export const MERGED_STATUSES: ReadonlySet<string> = new Set(['reviewing', 'signed_off']);

const runSchema = z.object({
  id: z.string(),
  state: z.string(),
  routineOwner: z.string().optional(),
  sessionUrl: z.string().nullable().optional(),
  purpose: z.string().optional(),
  lastProgressAt: z.string().nullable().optional(),
});

const artifactSchema = z.object({ kind: z.string(), commitSha: z.string().nullable().optional() });

const prSchema = z.object({ number: z.number(), state: z.string() });

/** The part of slop's glob view the commands use (get_glob, pick_up and merge all return it). */
const globSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  category: z.string(),
  /** Who works on it and how; absent on an older slop (read as the type and category). */
  actor: z.string().optional(),
  mode: z.string().optional(),
  fix: z.boolean().optional(),
  workKind: z.string().optional(),
  status: z.string(),
  version: z.number().int(),
  branch: z.string(),
  implementer: z.string().nullable(),
  provisioning: z.string(),
  environment: z.string().nullable().default(null),
  pr: prSchema.nullable(),
  currentRun: runSchema.nullable(),
  /** The latest version of each artifact (no content); absent on an older slop. */
  artifacts: z.array(artifactSchema).optional(),
});

export type GlobView = z.infer<typeof globSchema>;

const createdSchema = z.object({
  id: z.string(),
  /** An action has none unless it is prepared on a branch. */
  branch: z.string().optional(),
  type: z.string().nullable(),
  category: z.string(),
  actor: z.string().optional(),
  mode: z.string().optional(),
  fix: z.boolean().optional(),
  workKind: z.string().optional(),
  status: z.string(),
  provisioning: z.string(),
  after: z.array(z.string()).optional(),
  waiting: z.boolean().optional(),
  actionState: z.string().optional(),
});

/** The hand-over brief get_glob returns (see Handover in packages/core/src/domain/handover.ts); null when nothing is wrong. */
const handoverSchema = z
  .object({
    why: z.array(z.string()),
    next: z.string(),
    detail: z.array(z.string()).default([]),
  })
  .nullable();

const markedReadySchema = z.object({ id: z.string(), status: z.string(), pr: prSchema.nullable() });

export interface ParsedArgs {
  readonly flags: ReadonlySet<string>;
  /** Options that take a value (`--env dev` or `--env=dev`). */
  readonly values: ReadonlyMap<string, string>;
  readonly positionals: readonly string[];
}

/**
 * Splits flags from positionals; a flag outside `allowed` (or `valued`, for options that take a
 * value) is a usage error.
 */
export function parseArgs(
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

export function requireGlobId(id: string, usage: string): string {
  if (!GLOB_ID.test(id))
    throw new UsageError(`'${id}' is not a glob ID (like s1t4)\nusage: slop ${usage}`);
  return id;
}

export function requireRoot(deps: GlobDeps, command: string): string {
  if (deps.root === undefined) throw new SlopError(`${command}: run this inside a git checkout`);
  return deps.root;
}

/** The ID given, or the checked-out branch (a glob's branch is its ID). */
export async function globIdOrBranch(
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

export function parseGlob(value: unknown, tool: string): GlobView {
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

export async function getGlob(deps: GlobDeps, id: string): Promise<GlobView> {
  return parseGlob(await deps.client.call('get_glob', { id }), 'get_glob');
}

export function liveRun(glob: GlobView): GlobView['currentRun'] {
  const run = glob.currentRun;
  return run !== null && LIVE_RUN_STATES.has(run.state) ? run : null;
}

/** Who works on a glob and how, with the fix flag and work kind; an older slop sends only the type and category. */
function kindFields(glob: Pick<GlobView, 'category' | 'actor' | 'mode' | 'fix' | 'workKind'> & { readonly type: string | null }): Record<string, unknown> {
  const human = glob.category === 'decision' || glob.category === 'action';
  return {
    actor: glob.actor ?? (human ? 'human' : 'machine'),
    mode: glob.mode ?? (human ? glob.category : glob.type),
    fix: glob.fix ?? glob.category === 'bug',
    ...(glob.workKind === undefined ? {} : { workKind: glob.workKind }),
  };
}

/** "machine same fix": the short form of who, how and whether it fixes something. */
export function describeKind(glob: Pick<GlobView, 'category' | 'actor' | 'mode' | 'fix' | 'workKind'> & { readonly type: string | null }): string {
  const kind = kindFields(glob);
  return `${String(kind.actor)} ${String(kind.mode)}${kind.fix === true ? ' fix' : ''}`;
}

function globJson(glob: GlobView): Record<string, unknown> {
  return {
    id: glob.id,
    title: glob.title,
    type: glob.type,
    category: glob.category,
    ...kindFields(glob),
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
    `${glob.id} [${describeKind(glob)}] ${glob.status}: ${glob.title}` +
    ` (branch ${glob.branch}; ${glob.environment === null ? '' : `environment ${glob.environment}; `}` +
    `implementer ${glob.implementer ?? 'none'}; run ${run}; PR ${pr})`
  );
}

export function printJson(deps: GlobDeps, value: unknown): void {
  deps.stdout(`${JSON.stringify(value)}\n`);
}

/** `slop glob <id>`: print a glob's status, branch, implementer, run and PR. */
export async function globCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { flags, positionals } = parseArgs(args, ['--json'], GLOB_USAGE);
  const [id] = positionals;
  if (id === undefined || positionals.length !== 1)
    throw new UsageError(`usage: slop ${GLOB_USAGE}`);
  const glob = await getGlob(deps, requireGlobId(id, GLOB_USAGE));
  if (flags.has('--json')) printJson(deps, globJson(glob));
  else deps.stdout(`${describeGlob(glob)}\n`);
}

/** `slop handover <id>`: print why a person is needed on a glob and what to do first. */
export async function handoverCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { flags, positionals } = parseArgs(args, ['--json'], HANDOVER_USAGE);
  const [id] = positionals;
  if (id === undefined || positionals.length !== 1)
    throw new UsageError(`usage: slop ${HANDOVER_USAGE}`);
  const glob = await deps.client.call('get_glob', { id: requireGlobId(id, HANDOVER_USAGE) });
  parseGlob(glob, 'get_glob');
  const brief = handoverSchema.safeParse((glob as { handover?: unknown }).handover ?? null);
  if (!brief.success) throw new SlopError('get_glob: unexpected handover from slop');
  if (flags.has('--json')) {
    printJson(deps, brief.data);
    return;
  }
  const value = brief.data;
  if (value === null) {
    deps.stdout(`${id}: nothing is wrong; continue the plan\n`);
    return;
  }
  const lines = [
    'Why you are needed:',
    ...value.why.map((w) => `- ${w}`),
    '',
    'Do first:',
    value.next,
    ...(value.detail.length === 0 ? [] : ['', 'Detail:', ...value.detail.map((d) => `- ${d}`)]),
  ];
  deps.stdout(`${lines.join('\n')}\n`);
}

/**
 * `slop pick-up <id>`: become the implementer and wait for the branch. A queued or watching run holds nothing
 * unpushed, so slop supersedes it silently. An active run is mid-work: --take-over stops it without asking,
 * otherwise a terminal is asked and anything else is refused. pick_up is always called, since slop treats
 * re-picking your own glob as a no-op (and it moves your own failed glob back to in_progress).
 */
export async function pickUp(
  args: readonly string[],
  deps: GlobDeps,
): Promise<{ readonly glob: GlobView; readonly rollout: boolean; readonly json: boolean }> {
  const { flags, values, positionals } = parseArgs(args, ['--take-over', '--json'], PICK_UP_USAGE, [
    '--env',
  ]);
  const [given] = positionals;
  if (given === undefined || positionals.length !== 1)
    throw new UsageError(`usage: slop ${PICK_UP_USAGE}`);
  const id = requireGlobId(given, PICK_UP_USAGE);
  let takeOver = flags.has('--take-over');
  const environment = values.get('--env');

  const glob = await getGlob(deps, id);
  // A merged glob is refused by slop with what is left (its steps, labels) and how to follow up: show that, with its links made full.
  if (MERGED_STATUSES.has(glob.status)) {
    let accepted: GlobView;
    try {
      accepted = parseGlob(await deps.client.call('pick_up', { id, version: glob.version }), 'pick_up');
    } catch (e) {
      const base = deps.settings.SLOP_URL?.replace(/\/+$/, '');
      if (e instanceof SlopError && base !== undefined) throw new SlopError(e.message.replace(/(^|\s)(\/globs\/)/g, `$1${base}$2`));
      throw e;
    }
    // slop accepts a pick-up of a merged glob that still has open rollout steps: report it as a rollout pick-up. The glob's
    // branch may be gone after the merge, so don't wait for it; sstor works on the base branch.
    deps.log(`slop: picked up ${accepted.id} (${accepted.status}, merged: rollout steps)`);
    return { glob: accepted, rollout: true, json: flags.has('--json') };
  }
  const run = liveRun(glob);
  if (run !== null && !takeOver) {
    if (run.state === 'active') {
      const progress = run.lastProgressAt == null ? '' : `, last progress ${run.lastProgressAt}`;
      const message = `${id}'s machine run is working (${run.purpose ?? 'implementing'}${progress}); unpushed work will be lost.`;
      if (deps.ask === undefined) {
        const watch = run.sessionUrl ?? 'the glob view';
        throw new SlopError(`${message} rerun with --take-over to stop it, or watch it: ${watch}`);
      }
      const answer = await deps.ask(`${message} Take over? [y/N] `);
      if (!/^y(es)?$/i.test(answer.trim())) throw new SlopError(`${id}: not taken over`);
    } else {
      deps.log(`slop: took over ${id} from its ${run.state} run (nothing unpushed)`);
    }
    takeOver = true;
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
  return { glob: ready, rollout: false, json: flags.has('--json') };
}

export async function pickUpCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { glob, rollout, json } = await pickUp(args, deps);
  if (json) printJson(deps, rollout ? { ...globJson(glob), rollout: true } : globJson(glob));
  else deps.stdout(`${glob.branch}\n`);
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
/** The old category flags, now aliases: what each says about the fix flag and the work kind. `--feature` stays as a hidden alias (R&D; the glob is stored as a task) and is not in the help. */
const CATEGORY_FLAGS = { '--feature': 'feature', '--task': 'task', '--bug': 'bug' } as const;
const CATEGORY_KIND = {
  feature: { fix: false, workKind: 'rnd' },
  task: { fix: false, workKind: 'maintenance' },
  bug: { fix: true },
} as const;
const MODES: ReadonlySet<string> = new Set(['sub', 'same', 'super']);

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
    [...Object.keys(TYPE_FLAGS), ...Object.keys(CATEGORY_FLAGS), '--fix', '--routine', '--json', '--action', '--prepare'],
    NEW_USAGE,
    ['--env', '--after', '--mode', '--record'],
  );
  if (flags.has('--action')) return newAction(flags, values, positionals, deps);
  if (flags.has('--prepare') || values.has('--record')) throw new UsageError(`--prepare and --record are for --action\nusage: slop ${NEW_USAGE}`);
  const environment = values.get('--env');
  const after = (values.get('--after') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  for (const id of after) requireGlobId(id, NEW_USAGE);
  const flagType = oneOf(flags, TYPE_FLAGS);
  const modeValue = values.get('--mode');
  if (modeValue !== undefined && !MODES.has(modeValue)) throw new UsageError(`--mode is sub, same or super\nusage: slop ${NEW_USAGE}`);
  if (modeValue !== undefined && flagType !== undefined && modeValue !== flagType) {
    throw new UsageError(`--mode ${modeValue} contradicts --${flagType}`);
  }
  const type = (modeValue ?? flagType) as 'sub' | 'same' | 'super' | undefined;
  const category = oneOf(flags, CATEGORY_FLAGS);
  if (flags.has('--fix') && category !== undefined && category !== 'bug') {
    throw new UsageError(`--fix contradicts --${category}`);
  }
  const kind = category === undefined ? (flags.has('--fix') ? { fix: true } : undefined) : CATEGORY_KIND[category];
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
      ...(kind === undefined ? {} : kind),
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
      ...kindFields(glob),
      status: glob.status,
      routine: routineWillImplement,
      waiting: glob.waiting === true,
      after: glob.after ?? [],
    });
    return;
  }
  const who = glob.waiting === true
    ? `waits for ${(glob.after ?? []).join(', ')} to merge, then a routine will implement it`
    : routineWillImplement
      ? 'a routine will implement it'
      : glob.type === 'super'
        ? `it waits in Planning until you pick it up to pair: sstor --glob ${glob.id}`
        : 'pick it up to implement it';
  deps.stdout(
    `${glob.id} [${describeKind(glob)}] ${glob.status}: branch ${glob.branch}; ${who}\n`,
  );
}

const RECORDS: ReadonlySet<string> = new Set(['branch', 'artifact', 'attachment']);

/**
 * `slop new --action`: something a person does (an action). With `--prepare` a routine first prepares what they run, kept as
 * `--record` says (default: a branch). The first line is the title; a longer text is the plan.
 */
async function newAction(
  flags: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
  positionals: readonly string[],
  deps: GlobDeps,
): Promise<void> {
  const clash = ['--same', '--sub', '--super', '--fix', '--routine', '--env', '--mode', ...Object.keys(CATEGORY_FLAGS)].find((f) => flags.has(f) || values.has(f));
  if (clash !== undefined) throw new UsageError(`${clash} is for code work, not an action\nusage: slop ${NEW_USAGE}`);
  const prepare = flags.has('--prepare');
  const record = values.get('--record');
  if (record !== undefined && !prepare) throw new UsageError('--record needs --prepare');
  if (record !== undefined && !RECORDS.has(record)) throw new UsageError('--record is branch, artifact or attachment');
  const after = (values.get('--after') ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '');
  for (const id of after) requireGlobId(id, NEW_USAGE);
  const text = positionals.join(' ').trim();
  if (text === '') throw new UsageError(`usage: slop ${NEW_USAGE}`);
  const created = createdSchema.safeParse(
    await deps.client.call('create_glob', {
      board: boardSetting(deps.settings),
      idempotencyKey: deps.newIdempotencyKey(),
      actor: 'human',
      mode: 'action',
      title: text,
      ...(prepare ? { prepare: true, ...(record === undefined ? {} : { record }) } : {}),
      ...(after.length === 0 ? {} : { after, reason: 'the action needs it first' }),
    }),
  );
  if (!created.success) throw new SlopError('create_glob: unexpected response from slop');
  const glob = created.data;
  if (flags.has('--json')) {
    printJson(deps, { id: glob.id, branch: glob.branch ?? null, type: glob.type, category: glob.category, ...kindFields(glob), status: glob.status, actionState: glob.actionState ?? null, waiting: glob.waiting === true, after: glob.after ?? [] });
    return;
  }
  const what = !prepare
    ? 'a person does it, then marks it done'
    : glob.actionState === 'waiting'
      ? `waits for ${(glob.after ?? after).join(', ')}, then a routine prepares it`
      : 'a routine is preparing it; it shows "ready to run" when done';
  deps.stdout(`${glob.id} [${describeKind(glob)}] ${glob.status}: ${what}\n`);
}

// Untracked paths `slop init`, sstor and the agents leave in a worktree; not worth a warning.
const EXPECTED_UNTRACKED = ['.claude/', 'CLAUDE.md', '.reviews/', '.sstor/'];

function isUnexpectedUntracked(path: string): boolean {
  return !EXPECTED_UNTRACKED.some((prefix) =>
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix,
  );
}

/** Which of the implementation record and the local review slop holds for `sha`; undefined when this slop doesn't list artifacts. */
export function finaliseState(
  glob: GlobView,
  sha: string,
): { readonly record: boolean; readonly review: boolean } | undefined {
  if (glob.artifacts === undefined) return undefined;
  const at = (kind: string): boolean => glob.artifacts?.some((a) => a.kind === kind && a.commitSha === sha) === true;
  return { record: at('implementation_plan'), review: at('local_review') };
}

/** `slop ready` warns (it doesn't refuse) when slop has no implementation record or local review for the head. */
async function warnWithoutFinalise(deps: GlobDeps, root: string, glob: GlobView): Promise<void> {
  const state = finaliseState(glob, await deps.git.headSha(root));
  if (state === undefined || (state.record && state.review)) return;
  const missing = [...(state.record ? [] : ['implementation record']), ...(state.review ? [] : ['local review'])];
  deps.log(
    `slop: warning: ${glob.id} has no ${missing.join(' or ')} for the head commit; run \`slop finalise ${glob.id}\` first (it also submits learnings)`,
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
  await warnWithoutFinalise(deps, root, glob);
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
    printJson(deps, globJson(merged));
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

/**
 * `slop delete <id>`: delete a glob, with the glob view's rules (slop enforces them). Asks first on a terminal;
 * without one it needs `--yes`.
 */
export async function deleteCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { flags, values, positionals } = parseArgs(args, ['--yes', '--json'], DELETE_USAGE, ['--reason']);
  const [id] = positionals;
  if (id === undefined || positionals.length !== 1)
    throw new UsageError(`usage: slop ${DELETE_USAGE}`);
  const glob = await getGlob(deps, requireGlobId(id, DELETE_USAGE));
  if (!flags.has('--yes')) {
    if (deps.ask === undefined)
      throw new SlopError(`${id}: deleting needs a terminal to confirm; rerun with --yes`);
    const answer = await deps.ask(
      `Delete ${id} '${glob.title}'? This stops its run and closes its PR [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) throw new SlopError(`${id}: not deleted`);
  }
  await deps.client.call('delete_glob', {
    id,
    version: glob.version,
    reason: values.get('--reason') ?? 'Deleted with slop delete',
  });
  if (flags.has('--json')) printJson(deps, { deleted: id });
  else deps.stdout(`${id}: deleted\n`);
}

/**
 * `slop reopen <id> --reason <text>`: send a merged glob in Reviewing back to Doing as a new generation, like the glob view's
 * Reopen. The reason is required: the next run reads it as feedback. slop enforces where it applies.
 */
export async function reopenCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { flags, values, positionals } = parseArgs(args, ['--json'], REOPEN_USAGE, ['--reason']);
  const [id] = positionals;
  const reason = values.get('--reason');
  if (id === undefined || positionals.length !== 1 || reason === undefined || reason.trim() === '')
    throw new UsageError(`usage: slop ${REOPEN_USAGE}`);
  const glob = await getGlob(deps, requireGlobId(id, REOPEN_USAGE));
  const reopened = parseGlob(await deps.client.call('reopen_glob', { id, version: glob.version, reason }), 'reopen_glob');
  if (flags.has('--json')) {
    printJson(deps, globJson(reopened));
    return;
  }
  deps.stdout(`${id}: ${reopened.status} (reopened as a new generation; approvals are cleared)\n`);
}
