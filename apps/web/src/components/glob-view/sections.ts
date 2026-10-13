import type { GlobSection } from '@/lib/glob-section';

/** The sections the page renders in its body, in order; `escalation` lives in the header (its chip), not here. */
export type BodySection = Exclude<GlobSection, 'escalation'>;

/** The sections the header owns: they have an anchor too, so `?section=` finds them. */
export const HEADER_SECTIONS: readonly GlobSection[] = ['escalation'];

/**
 * The sections of the glob view in the order they are rendered, by their `data-section` id
 * (the ids `?section=` deep links use). A new section is a new file plus one entry here.
 */
export const GLOB_VIEW_SECTIONS: readonly BodySection[] = [
  'conflict',
  'labels',
  'prerequisites',
  'size',
  'actions',
  'plan',
  'decision',
  'deploys',
  'environments',
  'tests',
  'human-steps',
  'artifacts',
  'choices',
  'assessment',
  'findings',
];
