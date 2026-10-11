import { describe, expect, it } from 'vitest';
import { actionTiers, orderActions } from '../src/lib/action-style';

describe('actionTiers', () => {
  it('makes one primary of the next-step actions and the rest secondary', () => {
    const tiers = actionTiers(['take_over', 'start', 'pick_up']);
    expect(tiers.get('start')).toBe('primary');
    expect(tiers.get('pick_up')).toBe('secondary');
    expect(tiers.get('take_over')).toBe('secondary');
  });

  it('never makes Start again primary', () => {
    expect(actionTiers(['start_again']).get('start_again')).toBe('destructive');
  });

  it('prefers Merge over Ready for review', () => {
    expect(actionTiers(['mark_ready', 'merge']).get('merge')).toBe('primary');
  });
});

describe('orderActions', () => {
  it('puts the primary first and destructive actions last', () => {
    expect(orderActions(['start_again', 'take_over', 'start'])).toEqual(['start', 'take_over', 'start_again']);
  });
});
