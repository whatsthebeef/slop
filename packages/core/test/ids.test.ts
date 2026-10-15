import { describe, expect, it } from 'vitest';
import { formatId, letterFor, letterOf } from '../src/domain/ids.js';
import type { Mode, WorkActor, WorkKind } from '../src/domain/types.js';

type Case = [WorkActor, Mode, boolean, WorkKind, string];

describe('letterFor', () => {
  it.each<Case>([
    ['machine', 'sub', false, 'rnd', 'f'],
    ['machine', 'same', false, 'rnd', 'f'],
    ['machine', 'super', false, 'rnd', 'f'],
    ['machine', 'sub', false, 'maintenance', 't'],
    ['machine', 'same', false, 'maintenance', 't'],
    ['machine', 'super', false, 'maintenance', 't'],
    ['machine', 'sub', true, 'rnd', 'b'],
    ['machine', 'same', true, 'maintenance', 'b'],
    ['human', 'decision', false, 'maintenance', 'k'],
    ['human', 'action', false, 'maintenance', 'a'],
    // Fix and work kind mean nothing for human work.
    ['human', 'decision', true, 'rnd', 'k'],
    ['human', 'action', true, 'rnd', 'a'],
  ])('%s %s fix=%s %s -> %s', (actor, mode, fix, workKind, letter) => {
    expect(letterFor({ actor, mode, fix, workKind })).toBe(letter);
  });

  it('agrees with the legacy letter for each legacy category', () => {
    expect(letterFor({ actor: 'machine', mode: 'same', fix: false, workKind: 'rnd' })).toBe(letterOf('feature'));
    expect(letterFor({ actor: 'machine', mode: 'same', fix: false, workKind: 'maintenance' })).toBe(letterOf('task'));
    expect(letterFor({ actor: 'machine', mode: 'same', fix: true, workKind: 'maintenance' })).toBe(letterOf('bug'));
    expect(letterFor({ actor: 'human', mode: 'decision', fix: false, workKind: 'maintenance' })).toBe(letterOf('decision'));
    expect(letterFor({ actor: 'human', mode: 'action', fix: false, workKind: 'maintenance' })).toBe(letterOf('action'));
  });

  it('builds IDs', () => {
    expect(formatId(3, letterFor({ actor: 'machine', mode: 'sub', fix: true, workKind: 'maintenance' }), 7)).toBe('s3b7');
  });
});
