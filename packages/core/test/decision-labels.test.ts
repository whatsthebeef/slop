import { describe, expect, it } from 'vitest';
import { DECISION_CHANNELS } from '../src/domain/attributes.js';
import { channelLabel, channelSource, scopeLabel } from '../src/domain/decision-glob.js';

describe('the labels of a decision', () => {
  it('writes each scope in plain words', () => {
    expect(scopeLabel({ kind: 'glob', ref: 's1t1' })).toBe('This glob only');
    expect(scopeLabel({ kind: 'future_work', ref: null })).toBe('All new globs');
    expect(scopeLabel({ kind: 'future_work', ref: 'web' })).toBe('New globs in group web');
    expect(scopeLabel({ kind: 'area_group', ref: 'web' })).toBe('Globs in group web');
    expect(scopeLabel({ kind: 'project', ref: null })).toBe('The whole project (existing and new globs)');
  });

  it('says where each channel came from: an agent, a person, or the Matrix', () => {
    expect(DECISION_CHANNELS.map((c) => [c, channelSource(c), channelLabel(c)])).toEqual([
      ['agent', 'agent', 'From an agent'],
      ['mined', 'matrix', 'The Matrix'],
      ['inbox', 'person', 'From a person'],
      ['human', 'person', 'From a person'],
      ['migration', 'person', 'From a person'],
    ]);
  });
});
