import type { ArtifactSummary } from './knowledge.js';
import { currentRun } from './machine.js';
import type { ReviewFinding, ReviewSource } from './findings.js';
import { QUEUED_NOTICE_MINUTES, STUCK_MINUTES, checksExplanation } from './readiness.js';
import type { Glob, Run } from './types.js';

/**
 * The brief a person gets when they pick a glob up or take it over: why they are needed, what to do first, and the
 * detail behind it. `why` has one short sentence per cause (most actionable first), `next` is the first cause's step.
 */
export interface Handover {
  readonly why: readonly string[];
  readonly next: string;
  readonly detail: readonly string[];
}

/** What the brief needs besides the glob: read by the caller, so the brief stays pure. */
export interface HandoverFacts {
  readonly now: string;
  /** In-scope classified findings of the newest local review (see `openFindings`). */
  readonly findings: number;
  /** The orchestrator phase a resumed run starts from (see `resumePhase`). */
  readonly resumePhase: number;
}

/** The label of the attachment a hand-over records. */
export const HANDOVER_LABEL = 'Handover';

/** Where a glob's findings are listed, relative to its page. */
const FINDINGS_LINK = '?section=findings';

/** The newest local review's findings that are in scope and classified and that the review doesn't report as fixed: the review comments still to fix. */
export const openFindings = (
  findings: readonly ReviewFinding[],
  sources: readonly ReviewSource[],
): number => {
  const newest = sources.reduce<ReviewSource | null>(
    (best, s) => (best === null || s.id > best.id ? s : best),
    null,
  );
  if (newest === null) return 0;
  return findings.filter(
    (f) =>
      f.sourceId === newest.id &&
      f.severity === 'in_scope' &&
      f.state === 'classified' &&
      !f.resolved,
  ).length;
};

/**
 * The orchestrator phase to resume from, from what was uploaded: nothing is phase 1, an investigation 3, an
 * implementation record 4, a local review 5 and a local review of the current head 6.
 */
export const resumePhase = (
  artifacts: readonly ArtifactSummary[],
  headSha: string | null,
): number => {
  const review = artifacts.find((a) => a.kind === 'local_review');
  if (review !== undefined) return headSha !== null && review.commitSha === headSha ? 6 : 5;
  if (artifacts.some((a) => a.kind === 'implementation_plan')) return 4;
  if (artifacts.some((a) => a.kind === 'investigation')) return 3;
  return 1;
};

interface Cause {
  readonly why: string;
  readonly next: string;
  readonly detail: readonly string[];
}

const minutesSince = (at: string, now: string): number =>
  Math.floor((Date.parse(now) - Date.parse(at)) / 60_000);

/** The last run that did work: an investigate-only run is not one. */
const lastWorkRun = (glob: Glob): Run | null => {
  const run = currentRun(glob);
  if (run !== null && run.purpose !== 'investigate') return run;
  return glob.runs.filter((r) => r.purpose !== 'investigate').at(-1) ?? null;
};

const conflictCause = (glob: Glob, now: string): Cause | null => {
  const open = glob.conflict ?? null;
  const failed = glob.failure?.conflict;
  const conflict =
    open ?? (failed === undefined ? null : { ...failed, since: null, at: glob.failure?.at ?? now });
  if (conflict === null) return null;
  // Not conflictHint: its tail ("Resolve locally: sstor ...") is the card's, and this brief is for the person already taking over.
  const shown = conflict.files.slice(0, 5).join(', ');
  const more = conflict.files.length > 5 ? ` and ${String(conflict.files.length - 5)} more` : '';
  const files = conflict.files.length === 0 ? '' : `: ${shown}${more}`;
  const cause = conflict.since === null ? '' : ` since ${conflict.since} merged`;
  return {
    why: `Conflicts with ${conflict.base}${cause}${files}.`,
    next: `Merge origin/${conflict.base}, resolve (additive conflicts keep both sides; ask about logic conflicts), run the checks, push.`,
    detail: [
      ...(conflict.files.length > 5
        ? [`More conflicting files: ${conflict.files.slice(5).join(', ')}`]
        : []),
      ...(open === null && glob.failure !== null ? [`Reason: ${glob.failure.reason}`] : []),
    ],
  };
};

const failureCause = (glob: Glob, facts: HandoverFacts): Cause | null => {
  const failure = glob.failure;
  // A failed merge on a conflict is the conflict cause.
  if (failure === null || failure.conflict !== undefined) return null;
  const decision = failure.decision;
  return {
    why: `Failed: ${failure.reason}`,
    next:
      decision === undefined
        ? `Fix the cause, then continue from phase ${String(facts.resumePhase)}.`
        : `Answer the decision (ask the developer), then continue from phase ${String(facts.resumePhase)}.`,
    detail: decision === undefined ? [] : [`Decision needed: ${decision}`],
  };
};

const checksCause = (glob: Glob): Cause | null => {
  const checks = checksExplanation(glob);
  if (checks === null || checks.inherited) return null;
  const head = glob.pr?.headSha ?? null;
  return {
    why: `Checks failed: ${checks.text}`,
    next: 'Reproduce with the failing CI command locally and fix.',
    detail: [
      ...checks.lines,
      ...(checks.url === null ? [] : [`Run: ${checks.url}`]),
      ...(head === null ? [] : [`Head: ${head}`]),
    ],
  };
};

const runCause = (glob: Glob, facts: HandoverFacts): Cause | null => {
  const run = lastWorkRun(glob);
  if (run === null) return null;
  const session = run.sessionUrl === null ? [] : [`Session: ${run.sessionUrl}`];
  const next = `Resume from the last uploaded phase (\`--from ${String(facts.resumePhase)}\`).`;
  if (run.outcome === 'failed') {
    // The glob's own failure already says it.
    if (glob.failure !== null) return null;
    const progress = run.lastProgressAt ?? run.startedAt;
    return {
      why: `The last run ended without finishing${run.failureReason === null ? '' : `: ${run.failureReason}`}`,
      next,
      detail: [
        `Outcome: failed`,
        ...(progress === null ? [] : [`Last progress: ${progress}`]),
        ...session,
      ],
    };
  }
  if (run.state === 'active' || run.state === 'watching') {
    // A run that only watches a merging, armed or queued glob has nothing to report: the merge is slop's and GitHub's to
    // finish. The glob's own failure (a dequeue, a failed merge) is its own cause.
    if (glob.status === 'merging' || glob.mergeMode === 'when_green' || glob.mergeQueue != null) return null;
    const progress = run.lastProgressAt ?? run.startedAt ?? run.queuedAt;
    const minutes = minutesSince(progress, facts.now);
    if (minutes < STUCK_MINUTES) return null;
    return {
      why: `The run has made no progress for ${String(minutes)} minutes.`,
      next,
      detail: [`Last progress: ${progress}`, ...session],
    };
  }
  if (run.state === 'queued') {
    const minutes = minutesSince(run.queuedAt, facts.now);
    if (minutes < QUEUED_NOTICE_MINUTES) return null;
    return {
      why: `The run has been queued for ${String(minutes)} minutes without starting.`,
      next,
      detail: [`Queued: ${run.queuedAt}`, ...session],
    };
  }
  return null;
};

const findingsCause = (facts: HandoverFacts): Cause | null =>
  facts.findings === 0
    ? null
    : {
        why: `${String(facts.findings)} in-scope review finding${facts.findings === 1 ? '' : 's'} still open.`,
        next: 'Fix all review comments.',
        detail: [`Findings: ${FINDINGS_LINK}`],
      };

/**
 * Why a person is needed on this glob and what to do first; null when nothing is wrong. Causes are ordered most
 * actionable first, so a later one (a failing check on top of a conflict) never hides the first step. A cause for
 * human steps can be appended to the list.
 */
export const handoverBrief = (glob: Glob, facts: HandoverFacts): Handover | null => {
  // A signed-off glob needs nobody, whatever its last run or review said.
  if (glob.status === 'signed_off') return null;
  const causes = [
    conflictCause(glob, facts.now),
    failureCause(glob, facts),
    checksCause(glob),
    runCause(glob, facts),
    findingsCause(facts),
  ].filter((c): c is Cause => c !== null);
  const first = causes[0];
  if (first === undefined) return null;
  return {
    why: causes.map((c) => c.why),
    next: first.next,
    detail: causes.flatMap((c) => c.detail),
  };
};

/** The brief as the markdown of a "Handover" attachment. */
export const handoverMarkdown = (brief: Handover): string =>
  [
    '## Why you are needed',
    ...brief.why.map((w) => `- ${w}`),
    '',
    '## Do first',
    brief.next,
    ...(brief.detail.length === 0 ? [] : ['', '## Detail', ...brief.detail.map((d) => `- ${d}`)]),
  ].join('\n');
