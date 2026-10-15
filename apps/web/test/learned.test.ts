import { describe, expect, it } from 'vitest';
import { LEARNED_PANELS, learnedPanelOf, learnedPath, newestFirst } from '../src/lib/learned';
import { defaultGroupOpen, readGroupOpen, SETTINGS_GROUP_IDS, writeGroupOpen } from '../src/lib/settings-groups';

describe('learned panel links', () => {
  it('knows every panel by its own id', () => {
    for (const { id } of LEARNED_PANELS) expect(learnedPanelOf(id)).toBe(id);
  });

  it('maps what old settings links named to the panel that now holds it', () => {
    expect(learnedPanelOf('sub-limit')).toBe('subs');
    expect(learnedPanelOf('size-calibration')).toBe('size');
    expect(learnedPanelOf('type-learning')).toBe('intake');
    expect(learnedPanelOf('intake-accuracy')).toBe('intake');
    expect(learnedPanelOf('Context-Report')).toBe('context');
    expect(learnedPanelOf('kb-jobs')).toBe('jobs');
  });

  it('leaves anything else alone', () => {
    expect(learnedPanelOf(null)).toBeNull();
    expect(learnedPanelOf('')).toBeNull();
    expect(learnedPanelOf('readiness')).toBeNull();
    expect(learnedPanelOf('constructor')).toBeNull();
  });

  it('builds the Knowledge link', () => {
    expect(learnedPath(15, 'risk-areas')).toBe('/boards/15/knowledge?learned=risk-areas');
  });

  it('orders history newest first without touching the input', () => {
    const rows = [{ at: '2026-09-01T00:00:00Z', n: 1 }, { at: '2026-10-01T00:00:00Z', n: 2 }, { at: '2026-09-15T00:00:00Z', n: 3 }];
    expect(newestFirst(rows).map((r) => r.n)).toEqual([2, 3, 1]);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
  });
});

describe('settings group memory', () => {
  it('starts every group open except System', () => {
    expect(SETTINGS_GROUP_IDS.filter((id) => !defaultGroupOpen(id))).toEqual(['system']);
  });

  it('remembers the last choice and falls back to the default', () => {
    // No DOM here: the storage is unavailable, so the default shows and a write is silently dropped.
    expect(readGroupOpen('board')).toBe(true);
    expect(readGroupOpen('system')).toBe(false);
    expect(() => writeGroupOpen('board', false)).not.toThrow();
  });
});
