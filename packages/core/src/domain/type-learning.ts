import { extractPlanFeatures } from './intake-learning.js';
import { areasMatching } from './risk-area.js';
import type { RiskArea } from './risk-area.js';
import type { SlopType } from './types.js';

/**
 * Type corrections (spec, Intake): every time a person retypes a glob, the change is recorded with what the plan looked
 * like, and the board's latest ones go into the intake prompt as examples. A board with none gets the catalog defaults.
 */

/** What the glob's plan.md v1 showed when a person retyped it: the evidence the next intake run can generalise from. */
export interface TypeSignals {
  /** Lines under a questions heading, plus lines that say something is undecided. */
  readonly openQuestions: number;
  /** "Discuss with", "decide whether", or a decisions section. */
  readonly decisionWording: boolean;
  /** Files the plan names that fall under one of the board's risk areas. */
  readonly riskAreaFiles: readonly string[];
  /** Task lines in the plan; null when it has none. */
  readonly sizeTasks: number | null;
}

export interface TypeCorrection {
  readonly id: number;
  readonly boardId: number;
  readonly globId: string;
  readonly fromType: SlopType;
  readonly toType: SlopType;
  /** The person's email. */
  readonly actor: string;
  readonly at: string;
  readonly signals: TypeSignals;
  /** Set by a reset: the row stays as history but no longer teaches intake. */
  readonly resetAt: string | null;
}

export type NewTypeCorrection = Omit<TypeCorrection, 'id' | 'resetAt'>;

/** How many of the board's latest corrections the intake prompt carries. */
export const TYPE_EXAMPLES_MAX = 8;
/** At most this many risk-area files are kept per correction, and shown per line. */
const MAX_RISK_FILES = 5;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const QUESTIONS_HEADING = /\b(?:open\s+)?questions?\b|\bunknowns?\b|\bto decide\b|\bundecided\b/i;
const UNDECIDED = /\b(?:tbd|to be decided|undecided|unresolved|open question)\b/i;
const DECISIONS_HEADING = /^(?:\W*)(?:decisions?|options|design (?:questions|decisions))\b/i;
const DECISION_WORDING =
  /\bdiscuss with\b|\bdecide (?:whether|between|on|how)\b|\bagree on\b|\bto be decided\b/i;

/** Reads the signals a person's retype is explained by from the glob's first plan. Pure: `areas` are the board's risk areas. */
export const extractTypeSignals = (plan: string, areas: readonly RiskArea[]): TypeSignals => {
  const features = extractPlanFeatures(plan);
  let openQuestions = 0;
  let decisionWording = DECISION_WORDING.test(plan);
  let inQuestions = false;
  for (const line of plan.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const title = heading[1] ?? '';
      inQuestions = QUESTIONS_HEADING.test(title);
      if (DECISIONS_HEADING.test(title)) decisionWording = true;
      continue;
    }
    if (inQuestions && LIST_ITEM.test(line)) openQuestions++;
    else if (!inQuestions && UNDECIDED.test(line)) openQuestions++;
  }
  const riskAreaFiles = features.filePaths
    .filter((path) => areasMatching(areas, [path]).length > 0)
    .slice(0, MAX_RISK_FILES);
  return {
    openQuestions,
    decisionWording,
    riskAreaFiles,
    sizeTasks: features.tasks > 0 ? features.tasks : null,
  };
};

/** The signals in words, for an example line: `open questions, risk-area files, no tasks`. */
export const signalPhrases = (signals: TypeSignals): string[] => [
  ...(signals.openQuestions > 0
    ? [
        signals.openQuestions === 1
          ? '1 open question'
          : `${String(signals.openQuestions)} open questions`,
      ]
    : []),
  ...(signals.decisionWording ? ['decision wording'] : []),
  ...(signals.riskAreaFiles.length > 0
    ? [`risk-area files (${signals.riskAreaFiles.join(', ')})`]
    : []),
  signals.sizeTasks === null
    ? 'no tasks'
    : `${String(signals.sizeTasks)} ${signals.sizeTasks === 1 ? 'task' : 'tasks'}`,
];

export const typeCorrectionLine = (
  c: Pick<TypeCorrection, 'fromType' | 'toType' | 'signals'>,
): string => `Changed from ${c.fromType} to ${c.toType}: ${signalPhrases(c.signals).join(', ')}`;

/** What a board that has corrected nothing is told: the catalog's defaults, by when a person is needed. */
export const TYPE_DEFAULTS: readonly { readonly when: string; readonly type: SlopType }[] = [
  { when: 'a settled small change with no open questions', type: 'sub' },
  { when: 'a change that touches a risk area', type: 'same' },
  {
    when: 'a plan with open design questions, "discuss with" or a decisions section, and no tasks',
    type: 'super',
  },
];

const MAX_LINE = 240;
const clip = (line: string): string =>
  line.length <= MAX_LINE ? line : `${line.slice(0, MAX_LINE - 1)}…`;

/** The prompt block: the board's latest corrections (newest first) or, when it has none, the defaults. Bounded in size. */
export const typeLearningBlock = (corrections: readonly TypeCorrection[]): string =>
  corrections.length === 0
    ? [
        'Type defaults (this board has not corrected a type yet):',
        ...TYPE_DEFAULTS.map((d) => `- ${d.when}: "${d.type}"`),
      ].join('\n')
    : [
        "Types this board's people changed after intake (most recent first); follow them over your own reading when the plan looks similar:",
        ...corrections.slice(0, TYPE_EXAMPLES_MAX).map((c) => `- ${clip(typeCorrectionLine(c))}`),
      ].join('\n');

/** What the Knowledge page's "What slop has learned" shows: whether the board has learned, the defaults it falls back on and its recent corrections. */
export interface TypeLearningView {
  readonly learned: boolean;
  readonly defaults: readonly { readonly when: string; readonly type: SlopType }[];
  readonly corrections: readonly TypeCorrection[];
}

export const typeLearningView = (corrections: readonly TypeCorrection[]): TypeLearningView => ({
  learned: corrections.length > 0,
  defaults: TYPE_DEFAULTS,
  corrections,
});
