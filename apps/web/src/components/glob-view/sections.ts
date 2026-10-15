import type { GlobSection } from '@/lib/glob-section';

/**
 * The sections of the glob view in the order they are rendered, by their `data-section` id
 * (the ids `?section=` deep links use). A new section is a new file plus one entry here.
 */
export const GLOB_VIEW_SECTIONS: readonly GlobSection[] = [
  'conflict',
  'escalation',
  'labels',
  'size',
  'actions',
  'plan',
  'decision',
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
 * A decision glob's order: the Decide block first (the way work globs lead with sign-off), the Human steps after the
 * assessments.
 */
export const DECISION_VIEW_SECTIONS: readonly GlobSection[] = [
  'decision',
  'conflict',
  'escalation',
  'labels',
  'related',
  'size',
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
 * A learning's order: the action row (its outcome is the main button) first, then the decision block, which holds all of
 * its content. The work-glob sections (Plan, Artifacts, Deploys, Environments, Tests, Findings, Size) have nothing to show
 * for a learning. The Activity log and edit fields that follow the actions come last (see `GlobDetail`).
 */
export const LEARNING_VIEW_SECTIONS: readonly GlobSection[] = [
  'actions',
  'decision',
  'conflict',
  'escalation',
  'labels',
  'related',
  'choices',
  'assessment',
  'human-steps',
];
