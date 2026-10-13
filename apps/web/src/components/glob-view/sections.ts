import type { GlobSection } from '@/lib/glob-section';

/**
 * The sections of the glob view in the order they are rendered, by their `data-section` id
 * (the ids `?section=` deep links use). A new section is a new file plus one entry here.
 */
export const GLOB_VIEW_SECTIONS: readonly GlobSection[] = [
  'conflict',
  'escalation',
  'labels',
  'prerequisites',
  'size',
  'actions',
  'plan',
  'decision',
  'deploys',
  'environments',
  'tests',
  'artifacts',
  'choices',
  'assessment',
  'findings',
];
