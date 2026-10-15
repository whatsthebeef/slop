import { describe, expect, it } from 'vitest';
import { decisionLinks, decisionsHref, entryVerdict, globHref, keyDecisions, recentAgentSetVersions, relativeTime, verdictMap } from '../src/lib/knowledge-page';

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
  it('links to the board with the Decision category selected', () => {
    expect(decisionsHref(3)).toBe('/boards/3?kind=decision');
  });
  it('labels decision links without showing ids', () => {
    expect(decisionLinks({ text: 't', globIds: ['s1f1'] })).toEqual([{ id: 's1f1', label: 'decision' }]);
    expect(decisionLinks({ text: 't', globIds: ['a', 'b'] }).map((l) => l.label)).toEqual(['decision 1', 'decision 2']);
    expect(decisionLinks({ text: 't' })).toEqual([]);
  });
});

describe('keyDecisions', () => {
  const entry = (text: string, key: boolean | undefined, at?: string) => ({ text, globIds: [text], ...(key === undefined ? {} : { key }), ...(at === undefined ? {} : { at }) });
  const texts = (groups: readonly { entries?: readonly { text: string }[] }[]) => groups.flatMap((g) => (g.entries ?? []).map((e) => e.text));

  it('shows only key entries, newest-backed first, and counts the rest for "N more"', () => {
    const result = keyDecisions([
      { area: 'Testing', entries: [entry('old key', true, '2026-01-01'), entry('plain', false, '2026-09-01'), entry('new key', true, '2026-08-01')] },
      { area: 'Deploys', entries: [entry('newest key', true, '2026-09-30'), entry('undated key', true)] },
    ]);
    expect(result.flagged).toBe(true);
    // Capped at three here: the oldest and the undated ones fall to the rest.
    const capped = keyDecisions(
      [
        { area: 'Testing', entries: [entry('old key', true, '2026-01-01'), entry('plain', false, '2026-09-01'), entry('new key', true, '2026-08-01')] },
        { area: 'Deploys', entries: [entry('newest key', true, '2026-09-30'), entry('undated key', true)] },
      ],
      2,
    );
    expect(texts(capped.shown)).toEqual(['new key', 'newest key']);
    expect(capped.shown.map((g) => g.area)).toEqual(['Testing', 'Deploys']);
    expect(texts(capped.more)).toEqual(['old key', 'plain', 'undated key']);
    expect(capped.moreCount).toBe(3);
    expect(texts(result.shown)).toEqual(['old key', 'new key', 'newest key', 'undated key']);
    expect(result.moreCount).toBe(1);
    expect(texts(result.more)).toEqual(['plain']);
  });

  it('shows at most 20 by default', () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry(`k${String(i).padStart(2, '0')}`, true, `2026-09-${String(i + 1).padStart(2, '0')}`));
    const result = keyDecisions([{ area: 'A', entries }]);
    expect(texts(result.shown)).toHaveLength(20);
    expect(result.moreCount).toBe(5);
    expect(texts(result.more)).toContain('k00');
  });

  it('treats a version without the flag anywhere as legacy and shows every entry', () => {
    const groups = [{ area: 'A', entries: [entry('a', undefined), entry('b', undefined)] }];
    expect(keyDecisions(groups)).toEqual({ flagged: false, shown: groups, more: [], moreCount: 0 });
  });

  it('has nothing to count when every entry is key', () => {
    const result = keyDecisions([{ area: 'A', entries: [entry('a', true, '2026-01-01')] }]);
    expect(result).toMatchObject({ flagged: true, more: [], moreCount: 0 });
  });
});

describe('keyDecisions with verdicts (s15f63)', () => {
  const entry = (text: string, key: boolean | undefined, at?: string) => ({ text, globIds: [text], ...(key === undefined ? {} : { key }), ...(at === undefined ? {} : { at }) });
  const texts = (groups: readonly { entries?: readonly { text: string }[] }[]) => groups.flatMap((g) => (g.entries ?? []).map((e) => e.text));
  const fb = (globId: string, verdict: 'pin' | 'hide') => ({ globId, verdict, by: 'a@b.c', at: '2026-10-01T00:00:00.000Z' });

  it('lets a pin make an entry key and a not key hide one, whatever the stored flag says', () => {
    const verdicts = verdictMap([fb('plain', 'pin'), fb('key', 'hide')]);
    const result = keyDecisions([{ area: 'A', entries: [entry('key', true, '2026-09-01'), entry('plain', false, '2026-01-01')] }], 20, verdicts);
    expect(texts(result.shown)).toEqual(['plain']);
    expect(texts(result.more)).toEqual(['key']);
  });

  it('counts pinned entries first toward the cap, however old', () => {
    const entries = [entry('new1', true, '2026-09-03'), entry('new2', true, '2026-09-02'), entry('old pinned', false, '2025-01-01')];
    const result = keyDecisions([{ area: 'A', entries }], 2, verdictMap([fb('old pinned', 'pin')]));
    expect(texts(result.shown)).toEqual(['new1', 'old pinned']);
    expect(texts(result.more)).toEqual(['new2']);
  });

  it('reads an entry\'s verdict from any of its decisions, a pin first', () => {
    const verdicts = verdictMap([fb('a', 'hide'), fb('b', 'pin')]);
    expect(entryVerdict({ text: 't', globIds: ['a', 'b'] }, verdicts)).toBe('pin');
    expect(entryVerdict({ text: 't', globIds: ['a'] }, verdicts)).toBe('hide');
    expect(entryVerdict({ text: 't', globIds: ['c'] }, verdicts)).toBeNull();
  });
});

describe('recentAgentSetVersions', () => {
  it('lists the newest first, at most ten, and copes with no history or no changed files', () => {
    expect(recentAgentSetVersions(undefined)).toEqual([]);
    const history = Array.from({ length: 12 }, (_, i) => ({ version: i + 1, at: '2026-10-01T00:00:00.000Z', changedPaths: i === 0 ? [] : ['agents/a.md'] }));
    const result = recentAgentSetVersions(history);
    expect(result.map((v) => v.version)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(recentAgentSetVersions([{ version: 1, at: 'x' }])).toEqual([{ version: 1, at: 'x' }]);
  });
});
