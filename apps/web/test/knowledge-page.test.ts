import { describe, expect, it } from 'vitest';
import { changeText, decisionLinks, globHref, newestFirst, relativeTime } from '../src/lib/knowledge-page';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');

describe('relativeTime', () => {
  it('words recent times and dates old ones', () => {
    expect(relativeTime('2026-10-12T11:59:40.000Z', NOW)).toBe('just now');
    expect(relativeTime('2026-10-12T11:59:00.000Z', NOW)).toBe('1 minute ago');
    expect(relativeTime('2026-10-12T09:00:00.000Z', NOW)).toBe('3 hours ago');
    expect(relativeTime('2026-10-10T12:00:00.000Z', NOW)).toBe('2 days ago');
    expect(relativeTime('2026-07-01T12:00:00.000Z', NOW)).toBe('2026-07-01');
  });
});

describe('knowledge page helpers', () => {
  it('links to the glob on its board', () => {
    expect(globHref(3, 's3f1')).toBe('/boards/3?glob=s3f1');
  });
  it('words agent-set changes', () => {
    expect(changeText({ at: 'x', kind: 'agent_set', text: 'whatever', agentSetVersion: 7 })).toBe('Agent set v7 published');
    expect(changeText({ at: 'x', kind: 'work', text: 'Did a thing' })).toBe('Did a thing');
  });
  it('sorts changes newest first', () => {
    const sorted = newestFirst([
      { at: '2026-10-01T00:00:00.000Z', text: 'a' },
      { at: '2026-10-03T00:00:00.000Z', text: 'b' },
    ]);
    expect(sorted.map((c) => c.text)).toEqual(['b', 'a']);
  });
  it('labels decision links without showing ids', () => {
    expect(decisionLinks({ text: 't', globIds: ['s1f1'] })).toEqual([{ id: 's1f1', label: 'decision' }]);
    expect(decisionLinks({ text: 't', globIds: ['a', 'b'] }).map((l) => l.label)).toEqual(['decision 1', 'decision 2']);
    expect(decisionLinks({ text: 't' })).toEqual([]);
  });
});
