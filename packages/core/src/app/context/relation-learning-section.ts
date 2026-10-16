import type { RelationLearningView, RelationLearningSource } from '../../domain/relation-learning.js';

/** How reliable one source's relations have been on the board, as `get_context` tells an agent. */
export interface RelationLearningContext {
  readonly source: RelationLearningSource;
  /** Share of this source's relations that turned out right inside the window; null with no samples. */
  readonly precision: number | null;
  /** How many relations that rests on. */
  readonly samples: number;
  readonly windowDays: number;
  /** `gate`: this source's relations hold as usual. `weak`: they are made "may relate" links that hold nothing. */
  readonly posture: 'gate' | 'weak';
  /** One sentence an agent can act on. */
  readonly note: string;
}

/** The sources an agent hears about: its own first, then the two slop makes by itself. */
const SOURCES: readonly RelationLearningSource[] = ['agent', 'mention', 'inferred'];

const percent = (n: number): string => `${String(Math.round(n * 100))}%`;

const noteOf = (source: RelationLearningSource, precision: number | null, samples: number, windowDays: number, posture: 'gate' | 'weak', min: number): string => {
  const days = `${String(windowDays)} days`;
  const what = source === 'agent' ? 'Relations agents add' : source === 'mention' ? 'Relations slop makes from a mentioned glob' : 'Relations slop infers';
  if (precision === null || samples < min) {
    return `${what} have too few outcomes on this board to measure yet (${String(samples)} in ${days}). Add a relation only for a concrete dependency: code this glob uses, or a file it must not race.`;
  }
  const rate = `${what} were needed ${percent(precision)} of the time on this board (${String(samples)} judged in ${days})`;
  if (posture === 'weak') return `${rate}, so slop now makes them weak "may relate" links that hold nothing back. Add a gating relation only for a concrete dependency, not a mention in passing.`;
  return precision < 0.8
    ? `${rate}. Add a relation only for a concrete dependency (code this glob uses, or a file it must not race), not a mention in passing.`
    : `${rate}. Keep adding relations for concrete dependencies only.`;
};

/** The relation-learning section of `get_context`: precision, samples and posture for the agent's own source and the automatic ones. */
export const relationLearningSection = (view: RelationLearningView): RelationLearningContext[] =>
  SOURCES.flatMap((source): RelationLearningContext[] => {
    const stats = view.sources.find((s) => s.source === source);
    if (stats === undefined) return [];
    const posture = stats.posture.posture;
    return [
      {
        source,
        precision: stats.precision,
        samples: stats.precisionSamples,
        windowDays: view.thresholds.windowDays,
        posture,
        note: noteOf(source, stats.precision, stats.precisionSamples, view.thresholds.windowDays, posture, view.thresholds.minSamples),
      },
    ];
  });
