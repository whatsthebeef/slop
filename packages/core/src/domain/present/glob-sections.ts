/** The parts of a glob's page a link can open it at (`?section=<name>`). */
export const GLOB_SECTIONS = [
  'plan',
  'artifacts',
  'findings',
  'labels',
  'holding',
  'holds-back',
  'no-longer-holding',
  'questions',
  'escalation',
  'size',
  'deploys',
  'tests',
  'choices',
  'decision',
  'assessment',
  'actions',
  'action',
  'human-steps',
  'due-steps',
] as const;

export type GlobSection = (typeof GLOB_SECTIONS)[number];

/** Where a link into a glob points: a section, and for `artifacts` an artifact (and the label of an attachment or review). */
export interface GlobTarget {
  section?: GlobSection;
  artifact?: string;
  label?: string;
  /** The tab inside the section: `?section=plan&tab=test-plan` opens the Test plan beside plan.md. */
  tab?: string;
}
