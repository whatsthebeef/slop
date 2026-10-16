import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { isDismissed, shortLabel, stepKey, turnKey } from '../src/lib/dismissals';
import { statusLine } from '../src/lib/status-line';
import { NOW, glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const failed = (at = NOW, patch: Partial<GlobView> = {}) =>
  view({ status: 'failed', failure: { reason: 'Could not reproduce the bug: the whole paragraph', at }, ...patch });
const lineOf = (g: GlobView) => {
  const line = statusLine(g, NOW);
  if (line === null) throw new Error('no status line');
  return line;
};
describe('message keys', () => {
  it('step: by id and state; turn: by move', () => {
    expect(stepKey({ id: 'h1', state: 'due' })).not.toBe(stepKey({ id: 'h1', state: 'done' }));
    expect(turnKey({ reason: 'Merge', since: NOW })).toBe(turnKey({ reason: 'Merge', since: NOW }));
    expect(turnKey({ reason: 'Merge', since: NOW })).not.toBe(turnKey({ reason: 'Deploy', since: NOW }));
  });
});

describe('labels', () => {
  it('ignores stored problem dismissals: only the Your turn reason is read from dismissedKeys', () => {
    expect(isDismissed({}, 'x')).toBe(false);
    expect(isDismissed({ dismissedKeys: [`failure:${NOW}`] }, `turn:${NOW}:x`)).toBe(false);
  });

  it('names a conflict plainly', () => {
    expect(shortLabel({ ...lineOf(failed()), conflict: true })).toBe('merge conflict');
  });
});
