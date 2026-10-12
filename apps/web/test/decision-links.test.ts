import type { DecisionAttributes } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { closedText, linksByKind, targetText } from '../src/lib/decision-links';

const attributes = (patch: Partial<DecisionAttributes> = {}): DecisionAttributes => ({
  scope: { kind: 'project', ref: null },
  origin: { kind: 'submitted' },
  channel: 'agent',
  outcome: null,
  ...patch,
});

describe('a learning on its decision', () => {
  it('says how the pipeline closed it', () => {
    expect(closedText(attributes())).toBeNull();
    expect(closedText(attributes({ closedAs: 'merged' }))).toMatch(/merged it into another learning/);
    expect(closedText(attributes({ closedAs: 'suppressed' }))).toMatch(/rejected learning/);
    expect(closedText(attributes({ closedAs: 'covered' }))).toMatch(/approved learning/);
    expect(closedText(attributes({ closedAs: 'covered', coveredByText: { kind: 'knowledge', knowledgeKind: 'doc', name: 'build', section: null } }))).toMatch(/build already says it/);
  });

  it('names its target, routed or suggested', () => {
    expect(targetText(attributes())).toBeNull();
    expect(targetText(attributes({ target: { suggested: 'the build doc', routed: null } }))).toBe('suggested: the build doc');
    expect(targetText(attributes({ target: { suggested: null, routed: { kind: 'doc', name: 'build', section: 'Test', newDocument: null } } }))).toBe('doc build § Test');
  });

  it('groups its links by kind, in a fixed order', () => {
    expect(linksByKind(undefined)).toEqual([]);
    expect(
      linksByKind([
        { id: 's1k3', kind: 'kept_apart_from', source: 'explicit' },
        { id: 's1k2', kind: 'contradicts', source: 'pipeline', detail: { note: 'x' } },
        { id: 's1k4', kind: 'kept_apart_from', source: 'explicit' },
        { id: 's1k1', kind: 'duplicate_of', source: 'pipeline' },
      ]),
    ).toEqual([
      { kind: 'duplicate_of', ids: ['s1k1'] },
      { kind: 'contradicts', ids: ['s1k2'] },
      { kind: 'kept_apart_from', ids: ['s1k3', 's1k4'] },
    ]);
  });
});
