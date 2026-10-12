import { describe, expect, it } from 'vitest';
import { reviewFormOf, reviewSettingsOfForm, spendBreakdown, spendLine, toolCapInvalid } from '../src/lib/review-settings';

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
    expect(spendLine({ usd: 0, unpricedCalls: 0 })).toBe('LLM spend this month $0.00');
    expect(spendLine({ usd: 1.2345, unpricedCalls: 0 })).toBe('LLM spend this month $1.23');
  });

  it('says how many calls had no price', () => {
    expect(spendLine({ usd: 2, unpricedCalls: 1 })).toBe(
      'LLM spend this month $2.00 + 1 unpriced call',
    );
    expect(spendLine({ usd: 2, unpricedCalls: 3 })).toBe(
      'LLM spend this month $2.00 + 3 unpriced calls',
    );
  });
});

describe('spend breakdown', () => {
  it('lists each source with its cost, costliest first, then the unpriced calls', () => {
    expect(
      spendBreakdown({ bySource: { review: 0.1, chat: 0.4234, kb_draft: 1.5, intake: 0.1 }, unpricedCalls: 2 }),
    ).toBe('kb_draft $1.50\nchat $0.42\nintake $0.10\nreview $0.10\n2 unpriced calls');
    expect(spendBreakdown({ bySource: { chat: 1 }, unpricedCalls: 1 })).toBe('chat $1.00\n1 unpriced call');
  });

  it('names the sources of unpriced calls, also a source with no priced calls at all', () => {
    expect(
      spendBreakdown({
        bySource: { chat: 0.5, intake: 0.1 },
        unpricedBySource: { chat: 1, kb_draft: 3, review: 1 },
        unpricedCalls: 5,
      }),
    ).toBe('chat $0.50 + 1 unpriced\nintake $0.10\nkb_draft 3 unpriced\nreview 1 unpriced\n5 unpriced calls');
    expect(spendBreakdown({ bySource: {}, unpricedBySource: { size_check: 2 }, unpricedCalls: 2 })).toBe(
      'size_check 2 unpriced\n2 unpriced calls',
    );
  });

  it('says there is nothing yet, and copes with an older API that sends no breakdown', () => {
    expect(spendBreakdown({ bySource: {}, unpricedCalls: 0 })).toBe('No LLM spend yet this month');
    expect(spendBreakdown({ unpricedCalls: 0 })).toBe('No LLM spend yet this month');
    expect(spendBreakdown({ unpricedCalls: 3 })).toBe('3 unpriced calls');
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
