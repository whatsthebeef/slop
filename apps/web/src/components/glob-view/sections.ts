import type { GlobSection } from '@/lib/glob-section';

/**
 * The sections of the glob view in the order they are rendered, by their `data-section` id
 * (the ids `?section=` deep links use). A new section is a new file plus one entry here. Above the actions the blocks come
 * in one order: problems (conflict, problem), then what needs a person (decision, labels, the due Human steps), then
 * information (escalation, size).
 */
export const GLOB_VIEW_SECTIONS: readonly GlobSection[] = [
  'questions',
  'conflict',
  'problem',
  'decision',
  'labels',
  'escalation',
  'size',
  'actions',
  'action',
  'plan',
  'deploys',
  'environments',
  'tests',
  'artifacts',
  'related',
  'human-steps',
  'choices',
  'assessment',
  'findings',
];

/**
 * A decision glob's order: the same blocks as a work glob (problems, then the Decide block and labels, then information), Holds
 * back just above the actions, and the Human steps after the assessments.
 */
export const DECISION_VIEW_SECTIONS: readonly GlobSection[] = [
  'conflict',
  'problem',
  'decision',
  'labels',
  'escalation',
  'size',
  'related',
  'actions',
  'plan',
  'deploys',
  'environments',
  'tests',
  'artifacts',
  'choices',
  'assessment',
  'findings',
  'human-steps',
];

/**
 * A learning's order: the same blocks above the actions as every other glob (conflict, problem, the decision block, labels,
 * escalation), then the action row (its outcome is the main button), then the information blocks. The work-glob sections
 * (Plan, Artifacts, Deploys, Environments, Tests, Findings, Size) have nothing to show for a learning. The Activity log and
 * edit fields that follow the actions come last (see `GlobDetail`).
 */
export const LEARNING_VIEW_SECTIONS: readonly GlobSection[] = [
  'conflict',
  'problem',
  'decision',
  'labels',
  'escalation',
  'actions',
  'related',
  'choices',
  'assessment',
  'human-steps',
];

/**
 * The order the glob view renders: while a step is due, the due-steps block sits with the other blocks that need a person,
 * after the Decide and review blocks and before the information blocks, in every kind of view. Otherwise the fixed order
 * above.
 */
export const viewSections = (decision: boolean, stepsDue: boolean, learning = false): readonly GlobSection[] => {
  const base = learning ? LEARNING_VIEW_SECTIONS : decision ? DECISION_VIEW_SECTIONS : GLOB_VIEW_SECTIONS;
  if (!stepsDue) return base;
  const at = base.indexOf('escalation');
  return [...base.slice(0, at), 'due-steps', ...base.slice(at)];
};
