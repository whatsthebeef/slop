import { describe, expect, it } from 'vitest';
import { changeText, percentText, settingValueText, sourceTypeText, TIER_TEXT } from '../src/lib/context-report';

describe('context report text', () => {
  it('shows shares as whole percents, and a tiny share as under one percent', () => {
    expect(percentText(0)).toBe('0%');
    expect(percentText(Number.NaN)).toBe('0%');
    expect(percentText(0.004)).toBe('<1%');
    expect(percentText(0.2549)).toBe('25%');
    expect(percentText(1)).toBe('100%');
  });

  it('shows a setting value with its unit only where the unit is a word', () => {
    expect(settingValueText(90, 'days')).toBe('90 days');
    expect(settingValueText(6000, 'characters')).toBe('6,000 characters');
    expect(settingValueText(0.725, 'similarity')).toBe('0.725');
    expect(settingValueText(0.1500000001, 'weight')).toBe('0.15');
  });

  it('shows a move and says when it was a reset', () => {
    expect(changeText({ before: 0.6, after: 0.55, outcome: 'discussion_replaced_often' }, 'weight')).toBe('0.6 → 0.55');
    expect(changeText({ before: 10, after: 8, outcome: 'reset' }, 'count')).toBe('10 → 8 (reset)');
  });

  it('names sources and tiers for people', () => {
    expect(sourceTypeText('decision')).toBe('Choice');
    expect(TIER_TEXT.discussion).toBe('Pasted discussion');
  });
});
