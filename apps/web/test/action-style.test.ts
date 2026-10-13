import { describe, expect, it } from 'vitest';
import { actionTiers, orderActions } from '../src/lib/action-style';

describe('actionTiers', () => {
  it('makes the main action primary and the rest secondary', () => {
    const tiers = actionTiers(['take_over', 'start', 'pick_up'], 'start');
    expect(tiers.get('start')).toBe('primary');
    expect(tiers.get('pick_up')).toBe('secondary');
    expect(tiers.get('take_over')).toBe('secondary');
  });

  it('has no primary without a main action', () => {
    expect(actionTiers(['start_anyway'], null).get('start_anyway')).toBe('secondary');
  });

  it('never makes Discard or Delete primary', () => {
    expect(actionTiers(['start_again', 'delete'], null).get('start_again')).toBe('destructive');
    expect(actionTiers(['start_again', 'delete'], 'start_again').get('start_again')).toBe('destructive');
  });
});

describe('orderActions', () => {
  it('puts the main action first and destructive actions last', () => {
    expect(orderActions(['start_again', 'take_over', 'start'], 'start')).toEqual(['start', 'take_over', 'start_again']);
  });
});
