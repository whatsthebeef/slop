import { resolve } from 'node:path';
import { z } from 'zod';
import { SlopError, UsageError } from './errors.js';
import {
  MERGED_STATUSES,
  describeKind,
  finaliseState,
  getGlob,
  globIdOrBranch,
  parseArgs,
  parseGlob,
  pickUp,
  printJson,
  requireGlobId,
  requireRoot,
  type GlobDeps,
  type GlobView,
} from './globs.js';
import type { Runner } from './process.js';
import { decideTeleport, teleportHandoff } from './teleport.js';

/** What the developer-lifecycle commands need beyond the glob commands; bin.ts wires the real ones, tests fakes. */
export interface LifecycleDeps extends GlobDeps {
  /** Launches claude (never anything else); tests record the calls instead. */
  readonly runner: Runner;
  /** The signed-in person's email (`slop whoami`). */
  readonly whoami: () => Promise<string>;
  /** Whether the directory already has a local Claude conversation. */
  readonly hasLocalConversation: (dir: string) => Promise<boolean>;
  /** `slop init` in a directory, for a glob's board. */
  readonly initCheckout: (dir: string, board: string) => Promise<void>;
  /** Reads a text file; undefined when it doesn't exist. */
  readonly readText: (path: string) => Promise<string | undefined>;
}

export const WORK_USAGE =
  'work <id> [--agent] [--teleport | --no-teleport] [--worktree <dir>] [--env <name>] [--take-over]';
export const STATUS_USAGE = 'status [<id>] [--json]';
export const ANSWER_USAGE = 'answer <id> <question> "<option or text>"';
export const STEP_USAGE =
  'step <id> <n|step-id> done [--note <text>] | failed "<output>" | dismiss "<reason>"';
export const FINALISE_USAGE = 'finalise [<id>] [--note "<why>"] [--learnings all|facts|none]';
export const START_USAGE = 'start <id> [--anyway] [--reason <text>] [--json]';

const LEARNINGS_MODES = ['all', 'facts', 'none'] as const;
type LearningsMode = (typeof LEARNINGS_MODES)[number];

/** The marker `/finalise` writes when it succeeded: the request ID, then the head commit. */
export const FINALISED_MARKER = '.sstor/.finalised';

function boardOf(id: string): string {
  return /^s([1-9]\d*)/.exec(id)?.[1] ?? '';
}

function fail(command: string, code: number): never {
  throw new SlopError(`${command} exited with code ${String(code)}`);
}

/**
 * `slop work <id>`: pick the glob up, switch this checkout to its branch (or add a worktree), install the agent set.
 * It stops there; `--agent` also launches Claude Code (the routine's conversation when it is yours, else /run-glob).
 */
export async function workCommand(args: readonly string[], deps: LifecycleDeps): Promise<void> {
  const { flags, values, positionals } = parseArgs(
    args,
    ['--agent', '--teleport', '--no-teleport', '--take-over'],
    WORK_USAGE,
    ['--worktree', '--env'],
  );
  const [given] = positionals;
  if (given === undefined || positionals.length !== 1)
    throw new UsageError(`usage: slop ${WORK_USAGE}`);
  const id = requireGlobId(given, WORK_USAGE);
  if (flags.has('--teleport') && flags.has('--no-teleport'))
    throw new UsageError('pass only one of --teleport, --no-teleport');
  if ((flags.has('--teleport') || flags.has('--no-teleport')) && !flags.has('--agent')) {
    throw new UsageError(`--teleport and --no-teleport are for --agent\nusage: slop ${WORK_USAGE}`);
  }
  const root = requireRoot(deps, 'work');
  const worktree = values.get('--worktree');
  if (worktree === undefined && (await deps.git.hasUncommittedChanges(root))) {
    throw new SlopError(
      'work: the working tree has uncommitted changes; commit or stash them, or use --worktree <dir>',
    );
  }
  // Read before pick-up, which supersedes a queued or watching routine run.
  const before = flags.has('--agent') ? await getGlob(deps, id) : undefined;

  const pickUpArgs = [
    id,
    ...(flags.has('--take-over') ? ['--take-over'] : []),
    ...(values.has('--env') ? ['--env', values.get('--env') ?? ''] : []),
  ];
  const { glob, rollout } = await pickUp(pickUpArgs, deps);

  await deps.git.fetch(root);
  let branch = glob.branch;
  if (rollout) {
    // A merged glob's branch may be gone: its rollout steps run from the base branch.
    const board = (await deps.client.call('get_board', { board: Number(boardOf(id)) })) as {
      baseBranch?: unknown;
    };
    if (typeof board.baseBranch !== 'string' || board.baseBranch === '')
      throw new SlopError('get_board: unexpected response from slop');
    if (board.baseBranch.startsWith('-'))
      throw new SlopError('get_board: unexpected base branch from slop');
    branch = board.baseBranch;
  }
  let dir = root;
  if (worktree === undefined) {
    await deps.git.checkoutBranch(root, branch);
  } else {
    dir = resolve(worktree);
    await deps.git.addWorktree(root, dir, branch);
  }
  await deps.initCheckout(dir, boardOf(id));
  deps.log(`slop: ${id} is set up on ${branch} in ${dir}`);
  deps.stdout(`${dir}\n`);

  if (!flags.has('--agent')) {
    deps.log(
      `slop: implement and commit, then \`slop finalise ${id} --note "…"\` and \`slop ready ${id}\` (or \`slop work ${id} --agent\` to hand it to Claude Code)`,
    );
    return;
  }
  const force = flags.has('--teleport')
    ? 'teleport'
    : flags.has('--no-teleport')
      ? 'no-teleport'
      : undefined;
  const decision = rollout
    ? ({ teleport: false, reason: 'a merged glob has no run to carry on' } as const)
    : decideTeleport({
        run: before?.currentRun ?? null,
        me: await deps.whoami(),
        hasLocalConversation: await deps.hasLocalConversation(dir),
        force,
      });
  if (decision.teleport && decision.session.startsWith('-'))
    throw new SlopError('work: unexpected session id in the run');
  if (force === 'teleport' && !decision.teleport)
    throw new SlopError(`work: cannot teleport: ${decision.reason}`);
  const launch = decision.teleport
    ? ['--teleport', decision.session, teleportHandoff(id)]
    : [`/run-glob ${id}`];
  deps.log(
    decision.teleport
      ? `slop: carrying on ${id}'s routine session in Claude Code`
      : `slop: starting Claude Code on /run-glob ${id} (${decision.reason})`,
  );
  const code = await deps.runner.run('claude', launch, dir);
  if (code !== 0) fail('claude', code);
}

const questionSchema = z.object({
  id: z.string(),
  text: z.string(),
  options: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  blocking: z.string().optional(),
  answer: z.unknown().optional(),
  dismissed: z.unknown().optional(),
});

const stepSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.string(),
  who: z.unknown().optional(),
  due: z.unknown().optional(),
  why: z.string().nullable().optional(),
  permissions: z.string().nullable().optional(),
  commands: z.array(z.string()).optional(),
  verify: z.string().nullable().optional(),
});

const extrasSchema = z.object({
  list: z.string().optional(),
  questions: z.array(questionSchema).optional(),
  humanSteps: z.array(stepSchema).optional(),
  failedChecks: z
    .object({
      text: z.string(),
      lines: z.array(z.string()).default([]),
      url: z.string().nullable().default(null),
      inherited: z.boolean().default(false),
    })
    .nullable()
    .optional(),
  handover: z
    .object({ why: z.array(z.string()), next: z.string(), detail: z.array(z.string()).default([]) })
    .nullable()
    .optional(),
});

type Extras = z.infer<typeof extrasSchema>;
type Question = z.infer<typeof questionSchema>;
type Step = z.infer<typeof stepSchema>;

interface View {
  readonly glob: GlobView;
  readonly extras: Extras;
}

async function readView(deps: GlobDeps, id: string): Promise<View> {
  const raw = await deps.client.call('get_glob', { id });
  const glob = parseGlob(raw, 'get_glob');
  const extras = extrasSchema.safeParse(raw);
  if (!extras.success) throw new SlopError('get_glob: unexpected response from slop');
  return { glob, extras: extras.data };
}

const openQuestions = (extras: Extras): Question[] =>
  (extras.questions ?? []).filter((q) => q.answer === undefined && q.dismissed === undefined);

/** Due steps with their 1-based position in the glob's full step list (what `slop step` takes as `n`). */
const dueSteps = (extras: Extras): Array<{ readonly n: number; readonly step: Step }> =>
  (extras.humanSteps ?? [])
    .map((step, index) => ({ n: index + 1, step }))
    .filter(({ step }) => step.state === 'due');

function nextStep(
  glob: GlobView,
  extras: Extras,
  finalised: ReturnType<typeof finaliseState>,
): string {
  const id = glob.id;
  if (MERGED_STATUSES.has(glob.status))
    return dueSteps(extras).length > 0
      ? `run the due steps (slop step ${id} <n> done)`
      : 'nothing: it is merged';
  const questions = openQuestions(extras);
  if (questions.length > 0)
    return `answer ${questions[0]?.id ?? ''}: slop answer ${id} ${questions[0]?.id ?? ''} "<answer>"`;
  if (dueSteps(extras).length > 0) return `do the due steps, then slop step ${id} <n> done`;
  if (extras.failedChecks != null && !extras.failedChecks.inherited)
    return 'fix the failing checks, commit and push';
  if (glob.status === 'pr_open' && glob.pr?.state === 'ready') return `slop merge ${id}`;
  if (glob.status === 'planning') return `slop start ${id} (or slop work ${id})`;
  if (finalised !== undefined && !(finalised.record && finalised.review))
    return `slop finalise ${id} --note "<why>", then slop ready ${id}`;
  return `slop ready ${id}`;
}

/** `slop status [<id>]`: one screen with the glob's state, questions, due steps, failed checks, PR and the next step. */
export async function statusCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { flags, positionals } = parseArgs(args, ['--json'], STATUS_USAGE);
  const id = await globIdOrBranch(deps, positionals, 'status', STATUS_USAGE);
  const { glob, extras } = await readView(deps, id);
  const head =
    deps.root === undefined ? undefined : await deps.git.headSha(deps.root).catch(() => undefined);
  const finalised = head === undefined ? undefined : finaliseState(glob, head);
  const questions = openQuestions(extras);
  const steps = dueSteps(extras);
  const next = nextStep(glob, extras, finalised);
  if (flags.has('--json')) {
    printJson(deps, {
      id: glob.id,
      title: glob.title,
      status: glob.status,
      list: extras.list ?? null,
      run: glob.currentRun,
      pr: glob.pr,
      handover: extras.handover ?? null,
      questions,
      steps: steps.map(({ n, step }) => ({ n, ...step })),
      failedChecks: extras.failedChecks ?? null,
      finalised: finalised ?? null,
      next,
    });
    return;
  }
  const lines = [`${glob.id} [${describeKind(glob)}] ${glob.status}: ${glob.title}`];
  const run = glob.currentRun;
  lines.push(
    `Run: ${run === null ? 'none' : `${run.state}${run.purpose === undefined ? '' : ` (${run.purpose})`}${run.sessionUrl == null ? '' : ` ${run.sessionUrl}`}`}`,
  );
  lines.push(`PR: ${glob.pr === null ? 'none' : `#${String(glob.pr.number)} ${glob.pr.state}`}`);
  const base = deps.settings.SLOP_URL?.replace(/\/+$/, '');
  if (base !== undefined) lines.push(`Glob: ${base}/globs/${glob.id}`);
  if (extras.handover != null)
    lines.push('', 'Needs you:', ...extras.handover.why.map((w) => `- ${w}`));
  if (questions.length > 0) {
    lines.push('', 'Open questions:');
    for (const q of questions) {
      lines.push(
        `${q.id}: ${q.text}`,
        ...(q.options ?? []).map((o) => `    - ${o}`),
        ...(q.commands ?? []).map((c) => `    $ ${c}`),
      );
    }
  }
  if (steps.length > 0) {
    lines.push('', 'Steps due:');
    for (const { n, step } of steps) {
      lines.push(`${String(n)}. ${step.title} (${step.id})`);
      if (step.why != null) lines.push(`    why: ${step.why}`);
      if (step.permissions != null) lines.push(`    permissions: ${step.permissions}`);
      lines.push(...(step.commands ?? []).map((c) => `    $ ${c}`));
      if (step.verify != null) lines.push(`    check: ${step.verify}`);
    }
  }
  if (extras.failedChecks != null) {
    lines.push(
      '',
      `Failed checks${extras.failedChecks.inherited ? ' (the base branch fails too)' : ''}: ${extras.failedChecks.text}`,
    );
    lines.push(...extras.failedChecks.lines.map((l) => `    ${l}`));
    if (extras.failedChecks.url !== null) lines.push(`    ${extras.failedChecks.url}`);
  }
  if (finalised !== undefined) {
    lines.push(
      '',
      `Head ${(head ?? '').slice(0, 8)}: implementation record ${finalised.record ? 'yes' : 'no'}, local review ${finalised.review ? 'yes' : 'no'}`,
    );
  }
  lines.push('', `Next: ${next}`);
  deps.stdout(`${lines.join('\n')}\n`);
}

/** `slop answer <id> <question> "<option or text>"`: answers a question like the glob view (an option's text picks the option). */
export async function answerCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { positionals } = parseArgs(args, [], ANSWER_USAGE);
  const [given, ref, ...rest] = positionals;
  const text = rest.join(' ').trim();
  if (given === undefined || ref === undefined || text === '')
    throw new UsageError(`usage: slop ${ANSWER_USAGE}`);
  const id = requireGlobId(given, ANSWER_USAGE);
  const { extras } = await readView(deps, id);
  const wanted = /^\d+$/.test(ref) ? `q${ref}` : ref;
  const question = openQuestions(extras).find((q) => q.id === wanted);
  if (question === undefined) {
    const open = openQuestions(extras).map((q) => q.id);
    throw new SlopError(
      `${id}: no open question '${ref}'${open.length === 0 ? ' (none is open)' : ` (open: ${open.join(', ')})`}`,
    );
  }
  const option = question.options?.find((o) => o.toLowerCase() === text.toLowerCase());
  await deps.client.call('answer_question', {
    id,
    questionId: question.id,
    answer: option === undefined ? text : '',
    ...(option === undefined ? {} : { option }),
  });
  deps.stdout(`${id}: answered ${question.id}\n`);
}

/** `slop step <id> <n|step-id> done|failed|dismiss`: human steps, with the glob view's tools. */
export async function stepCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { values, positionals } = parseArgs(args, [], STEP_USAGE, ['--note']);
  const [given, ref, verb, ...rest] = positionals;
  if (given === undefined || ref === undefined || verb === undefined)
    throw new UsageError(`usage: slop ${STEP_USAGE}`);
  const id = requireGlobId(given, STEP_USAGE);
  const text = rest.join(' ').trim();
  if (verb !== 'done' && verb !== 'failed' && verb !== 'dismiss')
    throw new UsageError(`the action is done, failed or dismiss\nusage: slop ${STEP_USAGE}`);
  if (verb === 'done' && text !== '')
    throw new UsageError(`use --note for what was done\nusage: slop ${STEP_USAGE}`);
  if (verb !== 'done' && (text === '' || values.has('--note'))) {
    throw new UsageError(
      `${verb} needs ${verb === 'failed' ? 'the failure output' : 'a reason'} as text\nusage: slop ${STEP_USAGE}`,
    );
  }
  const { glob, extras } = await readView(deps, id);
  const steps = extras.humanSteps ?? [];
  const step =
    steps.find((s) => s.id === ref) ?? (/^\d+$/.test(ref) ? steps[Number(ref) - 1] : undefined);
  if (step === undefined)
    throw new SlopError(
      `${id}: no step '${ref}' (${steps.length} step${steps.length === 1 ? '' : 's'}; slop status ${id} lists the due ones)`,
    );
  const base = { id, stepId: step.id, version: glob.version };
  if (verb === 'done') {
    const note = values.get('--note');
    await deps.client.call('complete_human_step', {
      ...base,
      ...(note === undefined ? {} : { note }),
    });
  } else if (verb === 'failed') {
    await deps.client.call('fail_human_step', { ...base, note: text });
  } else {
    await deps.client.call('dismiss_human_step', { ...base, reason: text });
  }
  deps.stdout(
    `${id}: step ${step.id} ${verb === 'done' ? 'done' : verb === 'failed' ? 'reported failed' : 'dismissed'}\n`,
  );
}

/** `slop start <id>`: hands a glob in Planning to the machine, like the glob view's Start. */
export async function startCommand(args: readonly string[], deps: GlobDeps): Promise<void> {
  const { flags, values, positionals } = parseArgs(args, ['--anyway', '--json'], START_USAGE, [
    '--reason',
  ]);
  const [given] = positionals;
  if (given === undefined || positionals.length !== 1)
    throw new UsageError(`usage: slop ${START_USAGE}`);
  const id = requireGlobId(given, START_USAGE);
  if (values.has('--reason') && !flags.has('--anyway'))
    throw new UsageError('--reason needs --anyway');
  const glob = await getGlob(deps, id);
  const started = parseGlob(
    await deps.client.call('start_glob', {
      id,
      version: glob.version,
      ...(flags.has('--anyway') ? { anyway: true } : {}),
      ...(values.has('--reason') ? { reason: values.get('--reason') ?? '' } : {}),
    }),
    'start_glob',
  );
  if (flags.has('--json')) printJson(deps, { id, status: started.status });
  else deps.stdout(`${id}: ${started.status}\n`);
}

/**
 * `slop finalise [<id>]`: runs the catalog's /finalise headless in this checkout (`claude -p`): the implementation
 * record, a local review and learnings. The default learnings mode is `facts` when no local agent conversation did the
 * work here, else `all`.
 */
export async function finaliseCommand(args: readonly string[], deps: LifecycleDeps): Promise<void> {
  const { values, positionals } = parseArgs(args, [], FINALISE_USAGE, ['--note', '--learnings']);
  const root = requireRoot(deps, 'finalise');
  const id = await globIdOrBranch(deps, positionals, 'finalise', FINALISE_USAGE);
  const current = await deps.git.currentBranch(root);
  if (current !== id)
    throw new SlopError(
      `finalise: ${id} is not the checked-out branch (${current ?? 'detached HEAD'}); run it in ${id}'s worktree`,
    );
  if (await deps.git.hasUncommittedChanges(root))
    throw new SlopError('finalise: the working tree has uncommitted changes; commit them first');
  const asked = values.get('--learnings');
  if (asked !== undefined && !LEARNINGS_MODES.some((m) => m === asked))
    throw new UsageError(`--learnings is all, facts or none\nusage: slop ${FINALISE_USAGE}`);
  const mode: LearningsMode =
    (asked as LearningsMode | undefined) ??
    ((await deps.hasLocalConversation(root)) ? 'all' : 'facts');
  const note = values.get('--note');
  const requestId = deps.newIdempotencyKey();
  const startSha = await deps.git.headSha(root);
  const prompt = `/finalise ${requestId} --learnings ${mode}${note === undefined ? '' : ` --note ${JSON.stringify(note)}`}`;
  deps.log(`slop: finalising ${id} at ${startSha.slice(0, 8)} (learnings: ${mode})`);
  const code = await deps.runner.run('claude', ['-p', prompt], root);
  if (code !== 0) fail('claude', code);
  const marker = (await deps.readText(resolve(root, FINALISED_MARKER)))
    ?.split('\n')
    .map((l) => l.trim());
  // A super's /finalise may merge the base branch, so the marker carries the head after the run.
  const sha = await deps.git.headSha(root);
  if (marker?.[0] !== requestId || marker[1] !== sha) {
    throw new SlopError(
      `finalise: /finalise did not finish (no completion marker for this run); read its output above and run it again`,
    );
  }
  const state = finaliseState((await readView(deps, id)).glob, sha);
  deps.stdout(
    `${id}: finalised at ${sha.slice(0, 8)} (learnings: ${mode}); slop has ${state === undefined ? 'its artifacts' : `the implementation record: ${state.record ? 'yes' : 'no'}, local review: ${state.review ? 'yes' : 'no'}`}. Next: slop ready ${id}\n`,
  );
}
