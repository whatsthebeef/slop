import { describe, expect, it } from 'vitest';
import { reviewFormOf, reviewSettingsOfForm, spendLine, toolCapInvalid } from '../src/lib/review-settings';

describe('review settings form', () => {
  it('shows the defaults as blank fields and sends them back as null', () => {
    const form = reviewFormOf({
      enabled: true,
      model: null,
      minSeverity: 'medium',
      ignoredPaths: [],
      toolCap: null,
    });
    expect(form).toEqual({
      enabled: true,
      model: '',
      minSeverity: 'medium',
      ignoredPaths: '',
      toolCap: '',
    });
    expect(reviewSettingsOfForm(form)).toEqual({
      enabled: true,
      model: null,
      minSeverity: 'medium',
      ignoredPaths: [],
      toolCap: null,
    });
  });

  it('round-trips a configured reviewer, one path per line without blanks', () => {
    const settings = {
      enabled: false,
      model: 'm1',
      minSeverity: 'high' as const,
      ignoredPaths: ['docs/**', 'gen/**'],
      toolCap: 20,
    };
    const form = reviewFormOf(settings);
    expect(form.ignoredPaths).toBe('docs/**\ngen/**');
    expect(reviewSettingsOfForm(form)).toEqual(settings);
    expect(
      reviewSettingsOfForm({
        ...form,
        model: ' m2 ',
        ignoredPaths: ' a/** \n\n  \nb/**\n',
        toolCap: ' 7 ',
      }),
    ).toMatchObject({
      model: 'm2',
      ignoredPaths: ['a/**', 'b/**'],
      toolCap: 7,
    });
  });
});

describe('spend line', () => {
  it('shows the month to date in dollars and cents', () => {
    expect(spendLine({ usd: 0, unpricedCalls: 0 })).toBe('Review LLM spend this month $0.00');
    expect(spendLine({ usd: 1.2345, unpricedCalls: 0 })).toBe('Review LLM spend this month $1.23');
  });

  it('says how many calls had no price', () => {
    expect(spendLine({ usd: 2, unpricedCalls: 1 })).toBe(
      'Review LLM spend this month $2.00 + 1 unpriced call',
    );
    expect(spendLine({ usd: 2, unpricedCalls: 3 })).toBe(
      'Review LLM spend this month $2.00 + 3 unpriced calls',
    );
  });
});

describe('tool cap field', () => {
  it('flags garbage and fractions as invalid, and accepts a blank or a whole number', () => {
    const form = reviewFormOf({ enabled: true, model: null, minSeverity: 'medium', ignoredPaths: [], toolCap: null });
    expect(toolCapInvalid(form)).toBe(false);
    expect(toolCapInvalid({ ...form, toolCap: ' 12 ' })).toBe(false);
    for (const toolCap of ['abc', '2.5', '1e', '--'])
      expect(toolCapInvalid({ ...form, toolCap }), toolCap).toBe(true);
  });
});
