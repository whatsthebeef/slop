import { describe, expect, it } from 'vitest';
import { relationLearningSection } from '../src/app/context/relation-learning-section.js';
import { posturesOf, precisionRecall, thresholdsOf, RELATION_LEARNING_SOURCES } from '../src/domain/relation-learning.js';
import type { RelationLearningView, RelationSignal, RelationSignalKind, RelationSignalSource } from '../src/domain/relation-learning.js';

const NOW = '2026-10-16T12:00:00.000Z';
let n = 0;
const signals = (count: number, source: RelationSignalSource, kind: RelationSignalKind): RelationSignal[] =>
  Array.from({ length: count }, () => ({ id: `s${++n}`, boardId: 1, from: 'a', to: 'b', relationId: null, source, signal: kind, at: NOW, evidence: '', key: `k${n}` }));

const viewOf = (all: readonly RelationSignal[]): RelationLearningView => {
  const stats = precisionRecall(all, NOW);
  const postures = posturesOf(stats, {});
  return { thresholds: thresholdsOf(), defaults: thresholdsOf(), sources: RELATION_LEARNING_SOURCES.map((s) => ({ ...stats[s], posture: postures[s] })), pins: {} };
};

const relationLearning = (all: readonly RelationSignal[]): ReturnType<typeof relationLearningSection> => relationLearningSection(viewOf(all));

describe('the relationLearning section of get_context', () => {
  it('lists the agent source first, then mention and inferred, with the window', () => {
    const section = relationLearningSection(viewOf([]));
    expect(section.map((s) => s.source)).toEqual(['agent', 'mention', 'inferred']);
    expect(section[0]).toMatchObject({ precision: null, samples: 0, windowDays: 90, posture: 'gate' });
    expect(section[0]?.note).toContain('too few outcomes');
    expect(section[0]?.note).toContain('concrete');
  });

  it('gives the precision and sample count, and says when a source is made weak', () => {
    const section = relationLearning([...signals(8, 'mention', 'fp_override'), ...signals(2, 'mention', 'tp_needed'), ...signals(5, 'agent', 'tp_needed'), ...signals(1, 'agent', 'fp_dismissed')]);
    expect(section.find((s) => s.source === 'mention')).toMatchObject({ precision: 0.2, samples: 10, posture: 'weak' });
    expect(section.find((s) => s.source === 'mention')?.note).toContain('weak');
    const agent = section.find((s) => s.source === 'agent');
    expect(agent).toMatchObject({ samples: 6, posture: 'gate' });
    expect(agent?.precision).toBeCloseTo(5 / 6);
    expect(agent?.note).toContain('83%');
  });
});
