/** The panels of "What slop has learned" on the Knowledge page, in the order they are shown. */
export const LEARNED_PANELS = [
  { id: 'size', title: 'Size', blurb: 'When a glob counts as big, and how slop forecasts how much code a glob will change.' },
  { id: 'subs', title: 'Subs', blurb: 'How many changed lines a sub may have before it becomes a same.' },
  { id: 'risk-areas', title: 'Risk areas', blurb: 'The kinds of work intake sends to a person for review.' },
  { id: 'escalations', title: 'Escalation criteria', blurb: 'The reasons agents hand a sub to a person, and how slop has come to weigh each one.' },
  { id: 'dependency-rules', title: 'Dependency rules', blurb: 'The file paths slop uses to predict which globs will change the same files.' },
  { id: 'intake', title: 'Intake', blurb: "How intake chooses a glob's type, and how often its first choice held up." },
  { id: 'context', title: 'Context tuning', blurb: "What agents are handed from the board's records, and the numbers slop tunes for it." },
  { id: 'jobs', title: 'Learning jobs', blurb: 'The background jobs that do the learning: when each last ran, with Run now for admins.' },
] as const;

export type LearnedPanelId = (typeof LEARNED_PANELS)[number]['id'];

/**
 * What an old settings link's `?section=` named, and the panel that now holds it. The settings page never had anchors of
 * its own, so these are the names people used for the parts (and their old test ids); an unknown one is not redirected.
 */
const OLD_SECTIONS = new Map<string, LearnedPanelId>([
  ['size', 'size'],
  ['size-threshold', 'size'],
  ['size-calibration', 'size'],
  ['threshold', 'size'],
  ['calibration', 'size'],
  ['subs', 'subs'],
  ['sub-limit', 'subs'],
  ['risk-areas', 'risk-areas'],
  ['risk', 'risk-areas'],
  ['escalations', 'escalations'],
  ['escalation', 'escalations'],
  ['dependency-rules', 'dependency-rules'],
  ['dependencies', 'dependency-rules'],
  ['intake', 'intake'],
  ['intake-accuracy', 'intake'],
  ['type-learning', 'intake'],
  ['types', 'intake'],
  ['context', 'context'],
  ['context-report', 'context'],
  ['context-tuning', 'context'],
  ['jobs', 'jobs'],
  ['kb-jobs', 'jobs'],
  ['learning-jobs', 'jobs'],
]);

/** The panel a `?section=` or `?learned=` value names (the panel's own id or an old settings name), or null. */
export const learnedPanelOf = (value: string | null): LearnedPanelId | null => {
  if (value === null) return null;
  const name = value.trim().toLowerCase();
  return OLD_SECTIONS.get(name) ?? null;
};

/** Where a panel lives: the Knowledge page opened at it. Build links to learned values with this, not by hand. */
export const learnedPath = (boardId: number, panel: LearnedPanelId): string => `/boards/${String(boardId)}/knowledge?learned=${panel}`;

/** History rows newest first, whatever order the server sent them in. */
export const newestFirst = <T extends { readonly at: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
