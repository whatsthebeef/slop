import type { ArtifactKind, LabelName } from '@slop/core';
import type { GlobTarget } from './glob-section';

/** Where each card chip or icon opens the glob view (`?section=…`); the card passes these to `onOpenSection`. */
export const cardTargets = {
  /** An artifact icon: the artifacts section with that artifact selected. */
  artifact: (kind: ArtifactKind): GlobTarget => ({ section: 'artifacts', artifact: kind }),
  /** The independent review's status ("1 finding", "(outdated)"). */
  findings: (): GlobTarget => ({ section: 'findings' }),
  /** The blocked-by / waits-for chip. */
  related: (): GlobTarget => ({ section: 'related' }),
  /** The "needs a human" chip. */
  escalation: (): GlobTarget => ({ section: 'escalation' }),
  /** The clash chip. */
  conflict: (): GlobTarget => ({ section: 'conflict' }),
  /** The oversized and split chips. */
  size: (): GlobTarget => ({ section: 'size' }),
  /** A label's "open review", or the sign-off section as a whole without a label. */
  label: (name?: LabelName): GlobTarget => (name === undefined ? { section: 'labels' } : { section: 'labels', label: name }),
  /** A decision glob's scope, outcome and conflict chips. */
  decision: (): GlobTarget => ({ section: 'decision' }),
  /** The status chips and Your turn steps that need input: the glob view's actions. */
  actions: (): GlobTarget => ({ section: 'actions' }),
  /** The upcoming-steps marker and Your turn for a work step (a rollout): the Human steps section. */
  humanSteps: (): GlobTarget => ({ section: 'human-steps' }),
  /** The deploy indicator. */
  deploys: (): GlobTarget => ({ section: 'deploys' }),
} as const;
