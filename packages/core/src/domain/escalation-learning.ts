import type { DomainEvent } from './events.js';
import { namesGlob, SUB_LIMIT_WINDOW_DAYS } from './sub-limit.js';
import type { Glob } from './types.js';

/**
 * Escalation outcome learning (spec, Subs and escalation). Every escalation of a sub to a same (`escalate_to_same`) is
 * judged by what happened next, and so is every sub that merged without one:
 * - escalated, then merged with nothing asked of it: `unnecessary` (the criterion was too eager);
 * - escalated, then a person asked for changes (a sign-off label moved to `added`) or the merge was reverted: `justified`;
 * - not escalated, merged, then reverted or named by a bug in its window: `missed` (the criterion was too lax);
 * - a person de-escalating is a strong `unnecessary`; a person turning a merged sub's follow-up into a same, a strong `missed`.
 * Each outcome moves the score of the criterion that escalated (or should have), and a criterion's score gives its
 * stance: `loosened`, `default` or `strengthened`. The stances are the guidance the agents get through the board's KB
 * learnings; the history is shown on the Knowledge page's "What slop has learned", where an admin resets it. Pure: the store is in the service.
 */

/** The reasons an agent escalates for; `escalate_to_same` names one. */
export const ESCALATION_CRITERIA = [
  'design_decision',
  'risk_area',
  'data_rewrite',
  'auth_permissions',
  'weakened_tests',
  'agent_instructions',
  'scope_beyond_plan',
  'open_findings',
  'size',
  'other',
] as const;
export type EscalationCriterion = (typeof ESCALATION_CRITERIA)[number];

export const ESCALATION_OUTCOMES = ['unnecessary', 'justified', 'missed', 'reset'] as const;
export type EscalationOutcome = (typeof ESCALATION_OUTCOMES)[number];

/** What each criterion means, for the agents' guidance and for settings. */
export const CRITERION_TEXT: Record<EscalationCriterion, string> = {
  design_decision: 'a product or design decision the plan did not settle',
  risk_area: "work in one of the board's risk areas",
  data_rewrite: 'a rewrite of existing data',
  auth_permissions: 'auth, permissions or secrets changes',
  weakened_tests: 'weakened or deleted tests',
  agent_instructions: 'changed agent instructions',
  scope_beyond_plan: 'scope well beyond the plan',
  open_findings: 'in-scope review findings still open after the allowed rounds',
  size: 'a sub the size check flagged as too big for one pull request',
  other: 'another concrete reason',
};

/** How much one outcome moves a criterion's score (negative loosens it, positive strengthens it). */
export const OUTCOME_WEIGHT = {
  unnecessary: -1,
  deescalated: -3,
  justified: 1,
  missed: 2,
  missedFollowUp: 3,
} as const;
/** A criterion is `loosened` at or below this score, `strengthened` at or above the other. */
export const LOOSEN_AT = -1;
export const STRENGTHEN_AT = 1;

export type EscalationStance = 'loosened' | 'default' | 'strengthened';

/** One recorded outcome, with the cause (as plain text) that shows why. A reset has no glob. */
export interface EscalationRecord {
  readonly id: number;
  readonly boardId: number;
  readonly at: string;
  readonly globId: string | null;
  readonly criterion: EscalationCriterion;
  readonly outcome: EscalationOutcome;
  /** Signed: what the outcome added to the criterion's score. */
  readonly weight: number;
  readonly cause: string;
}

export type NewEscalationRecord = Omit<EscalationRecord, 'id'>;

/** A criterion's learned state, for settings. */
export interface CriterionView {
  readonly criterion: EscalationCriterion;
  readonly text: string;
  readonly score: number;
  readonly stance: EscalationStance;
  /** Outcomes counted (since the last reset). */
  readonly unnecessary: number;
  readonly justified: number;
  readonly missed: number;
}

export interface EscalationView {
  readonly criteria: readonly CriterionView[];
  /** Newest first, resets included. */
  readonly history: readonly EscalationRecord[];
}

export const stanceOf = (score: number): EscalationStance =>
  score <= LOOSEN_AT ? 'loosened' : score >= STRENGTHEN_AT ? 'strengthened' : 'default';

/** The records that count: those after the board's last reset. */
export const sinceReset = (records: readonly EscalationRecord[]): EscalationRecord[] => {
  const resets = records.filter((r) => r.outcome === 'reset').map((r) => r.at);
  const last = resets.length === 0 ? null : resets.reduce((a, b) => (a > b ? a : b));
  return records.filter((r) => r.outcome !== 'reset' && (last === null || r.at > last));
};

/** Every criterion's score, outcome counts and stance from the board's records (newest first or not). */
export const criteriaOf = (records: readonly EscalationRecord[]): CriterionView[] => {
  const counting = sinceReset(records);
  return ESCALATION_CRITERIA.map((criterion) => {
    const mine = counting.filter((r) => r.criterion === criterion);
    const score = mine.reduce((sum, r) => sum + r.weight, 0);
    return {
      criterion,
      text: CRITERION_TEXT[criterion],
      score,
      stance: stanceOf(score),
      unnecessary: mine.filter((r) => r.outcome === 'unnecessary').length,
      justified: mine.filter((r) => r.outcome === 'justified').length,
      missed: mine.filter((r) => r.outcome === 'missed').length,
    };
  });
};

const isCriterion = (value: unknown): value is EscalationCriterion =>
  typeof value === 'string' && (ESCALATION_CRITERIA as readonly string[]).includes(value);

const KEYWORDS: readonly (readonly [EscalationCriterion, RegExp])[] = [
  ['agent_instructions', /agent instruction|\.claude|claude\.md|agents\.md/i],
  ['auth_permissions', /\bauth|permission|secret|token|credential/i],
  ['data_rewrite', /migration|rewrite|backfill|existing data/i],
  ['weakened_tests', /weaken|deleted test|removed test|skipp?ed test/i],
  ['risk_area', /risk area/i],
  ['open_findings', /finding/i],
  ['scope_beyond_plan', /scope|beyond the plan/i],
  ['design_decision', /design|product decision|unplanned|unsettled|decision/i],
];

/** The criterion an escalation names; one without a valid name is read from its reason and evidence. */
export const criterionOf = (named: unknown, reason: string, evidence = ''): EscalationCriterion => {
  if (isCriterion(named)) return named;
  const text = `${reason}\n${evidence}`;
  return KEYWORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
};

/** The criterion a change to these paths would have been escalated for; `other` when none is clear. */
export const criterionForPaths = (paths: readonly string[]): EscalationCriterion => {
  const any = (pattern: RegExp): boolean => paths.some((p) => pattern.test(p));
  if (any(/(^|\/)(\.claude\/|CLAUDE\.md$|AGENTS\.md$)/)) return 'agent_instructions';
  if (any(/(^|\/)(auth|oauth|security|secrets)(\/|$)/i)) return 'auth_permissions';
  if (any(/(drizzle|migrations)\/.*(rewrite|backfill)/i)) return 'data_rewrite';
  return 'other';
};

/** The events the learning reads. */
export const ESCALATION_EVENT_TYPES = ['Escalated', 'Deescalated', 'Merged', 'MergeReverted', 'LabelChanged', 'FieldsChanged'] as const;

/** An outcome to record: the glob, the criterion it moves and why. */
export interface EscalationCandidate {
  readonly globId: string;
  readonly outcome: Exclude<EscalationOutcome, 'reset'>;
  readonly criterion: EscalationCriterion;
  readonly weight: number;
  /** When it happened: the merge, the revert, the label or the de-escalation. */
  readonly at: string;
  readonly cause: string;
  /** The paths a `missed` outcome is classified from (the service fills them from the merge or the plan). */
  readonly needsPaths: boolean;
}

export interface EscalationFacts {
  /** The board's `ESCALATION_EVENT_TYPES` events, oldest first. */
  readonly events: readonly DomainEvent[];
  readonly globs: readonly Glob[];
  /** `recordKey`s already recorded. */
  readonly recorded: ReadonlySet<string>;
  readonly now: string;
}

export const recordKey = (globId: string, outcome: EscalationOutcome): string => `${globId}:${outcome}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const isSubToSame = (change: unknown): boolean =>
  typeof change === 'object' && change !== null && (change as { from?: unknown }).from === 'sub' && (change as { to?: unknown }).to === 'same';
const isSameToSub = (change: unknown): boolean =>
  typeof change === 'object' && change !== null && (change as { from?: unknown }).from === 'same' && (change as { to?: unknown }).to === 'sub';
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The outcomes the board's recent globs show, oldest first (pure). For each glob:
 * - a `Deescalated` event after its `Escalated` one: `unnecessary`, heavily;
 * - escalated and merged: a sign-off label moved to `added` or a revert after the escalation is `justified` (bad outcomes
 *   win); otherwise, once it is signed off or its window has passed, `unnecessary` (approved unchanged);
 * - never escalated, a sub that merged and was reverted, or named by a bug created within its window: `missed`;
 * - never escalated, a sub that merged and a person then turned a glob naming it into a same: `missed`, heavily.
 */
export const escalationCandidates = (facts: EscalationFacts): EscalationCandidate[] => {
  const now = Date.parse(facts.now);
  const out: EscalationCandidate[] = [];
  const byGlob = new Map<string, DomainEvent[]>();
  for (const e of facts.events) byGlob.set(e.globId, [...(byGlob.get(e.globId) ?? []), e]);
  const add = (c: EscalationCandidate): void => {
    if (!facts.recorded.has(recordKey(c.globId, c.outcome))) out.push(c);
  };
  for (const glob of facts.globs) {
    const events = byGlob.get(glob.id) ?? [];
    const escalated = events.find((e) => e.type === 'Escalated');
    const merged = events.find((e) => e.type === 'Merged');
    const reverted = events.find((e) => e.type === 'MergeReverted' && (merged === undefined || e.at >= merged.at));
    const windowEnd = merged === undefined ? 0 : Date.parse(merged.at) + SUB_LIMIT_WINDOW_DAYS * DAY_MS;
    if (escalated !== undefined) {
      const criterion = criterionOf(escalated.data.criterion, text(escalated.data.reason), text(escalated.data.evidence));
      // Size escalations are slop's own, made by the size check (it has its own learning): agents never raise them.
      if (criterion === 'size') continue;
      // Slop's own risk-area cleanup made it a sub again (no actor, no `Deescalated`): that is no outcome of the escalation.
      if (events.some((e) => e.type === 'FieldsChanged' && e.actor === null && isSameToSub(e.data.type) && e.at >= escalated.at)) continue;
      const deescalated = events.find((e) => e.type === 'Deescalated' && e.at >= escalated.at);
      if (deescalated !== undefined) {
        add({
          globId: glob.id,
          outcome: 'unnecessary',
          criterion,
          weight: OUTCOME_WEIGHT.deescalated,
          at: deescalated.at,
          cause: `${deescalated.actor ?? 'A person'} de-escalated it: "${text(escalated.data.reason)}"`,
          needsPaths: false,
        });
        continue;
      }
      if (merged === undefined) continue;
      const asked = events.find((e) => e.type === 'LabelChanged' && e.data.to === 'added' && e.at >= escalated.at);
      if (reverted !== undefined || asked !== undefined) {
        const label = asked === undefined ? '' : text(asked.data.label) || 'A sign-off label';
        add({
          globId: glob.id,
          outcome: 'justified',
          criterion,
          weight: OUTCOME_WEIGHT.justified,
          at: (reverted ?? asked ?? merged).at,
          cause:
            reverted !== undefined
              ? `Escalated for "${text(escalated.data.reason)}"; its merge was reverted`
              : `Escalated for "${text(escalated.data.reason)}"; ${label} review asked for changes`,
          needsPaths: false,
        });
      } else if (glob.status === 'signed_off' || now >= windowEnd) {
        add({
          globId: glob.id,
          outcome: 'unnecessary',
          criterion,
          weight: OUTCOME_WEIGHT.unnecessary,
          at: merged.at,
          cause: `Escalated for "${text(escalated.data.reason)}"; merged with nothing asked of it`,
          needsPaths: false,
        });
      }
      continue;
    }
    if (glob.type !== 'sub' || merged === undefined) continue;
    const mergedMs = Date.parse(merged.at);
    if (reverted !== undefined) {
      add({
        globId: glob.id,
        outcome: 'missed',
        criterion: 'other',
        weight: OUTCOME_WEIGHT.missed,
        at: reverted.at,
        cause: 'Merged as a sub with no escalation, then its merge was reverted',
        needsPaths: true,
      });
      continue;
    }
    const bug = facts.globs.find(
      (b) =>
        b.category === 'bug' &&
        Date.parse(b.createdAt) >= mergedMs &&
        Date.parse(b.createdAt) <= windowEnd &&
        namesGlob(b.title, glob.id),
    );
    if (bug !== undefined) {
      add({
        globId: glob.id,
        outcome: 'missed',
        criterion: 'other',
        weight: OUTCOME_WEIGHT.missed,
        at: bug.createdAt,
        cause: `Merged as a sub with no escalation, then ${bug.id} reported a bug naming it`,
        needsPaths: true,
      });
      continue;
    }
    // A person turning a follow-up that names the merged sub into a same says the sub needed a look.
    for (const f of facts.globs) {
      const turned = (byGlob.get(f.id) ?? []).find(
        (e) =>
          e.type === 'FieldsChanged' &&
          e.actor !== null &&
          isSubToSame(e.data.type) &&
          e.at >= merged.at &&
          Date.parse(e.at) <= windowEnd &&
          namesGlob(f.title, glob.id),
      );
      if (turned !== undefined) {
        add({
          globId: glob.id,
          outcome: 'missed',
          criterion: 'other',
          weight: OUTCOME_WEIGHT.missedFollowUp,
          at: turned.at,
          cause: `Merged as a sub with no escalation; ${turned.actor ?? 'a person'} then made its follow-up ${f.id} a same`,
          needsPaths: true,
        });
        break;
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
};

/** The learning statement for a criterion whose stance changed, as guidance for the agents' escalation judgement. */
export const guidanceStatement = (criterion: EscalationCriterion, stance: EscalationStance): string => {
  const what = CRITERION_TEXT[criterion];
  if (stance === 'loosened') {
    return `Escalating a sub to a same for ${what} has mostly been unnecessary on this board: people approved those unchanged or de-escalated them. Escalate for it only when something in the change makes it concrete; otherwise let the sub merge.`;
  }
  if (stance === 'strengthened') {
    return `Subs involving ${what} have needed a human on this board: escalated ones got changes asked for or were reverted, and unescalated ones were reverted or caused bugs. Escalate a sub to a same when it involves ${what}.`;
  }
  return `The board's history no longer shows a pattern for escalating a sub for ${what}: use the default escalation guidance for it.`;
};

/** The evidence line for a stance change: the records that moved it, newest first. */
export const guidanceEvidence = (criterion: EscalationCriterion, records: readonly EscalationRecord[]): string => {
  const lines = sinceReset(records)
    .filter((r) => r.criterion === criterion)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8)
    .map((r) => `${r.globId ?? 'board'} (${r.outcome}): ${r.cause}`);
  return `Escalation history for "${criterion}" on this board:\n${lines.join('\n')}`;
};
