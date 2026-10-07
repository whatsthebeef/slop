import { describe, expect, it } from 'vitest';
import { longEnoughQuote, verifiedQuote } from '../src/app/kb-dedupe.js';

const SHOWN = 'Generated files live in src/gen/ and are never edited by hand';

describe('verifiedQuote (s15b8)', () => {
  it('finds a quote ignoring case and whitespace', () => {
    expect(verifiedQuote('  generated FILES live\nin src/gen/ ', SHOWN)).toBe('generated FILES live\nin src/gen/');
  });

  it.each([
    ['an added trailing period', 'Generated files live in src/gen/.', 'Generated files live in src/gen/'],
    ['added quote marks and a period', '"Generated files live in src/gen/."', 'Generated files live in src/gen/'],
    ['curly quotes', '“are never edited by hand”', 'are never edited by hand'],
    ['punctuation at the start', ', and are never edited by hand!', 'and are never edited by hand'],
    ['each of ! ? ; : ,', 'never edited by hand!?;:,', 'never edited by hand'],
  ])('ignores %s at either end, returning the quote without them', (_, quote, found) => {
    expect(verifiedQuote(quote, SHOWN)).toBe(found);
  });

  it('keeps punctuation inside the quote', () => {
    expect(verifiedQuote('src/gen/. And are', SHOWN)).toBeNull();
    expect(verifiedQuote('Run vitest. Then eslint', 'Run vitest. Then eslint.')).toBe('Run vitest. Then eslint');
  });

  it.each([
    ['nothing but punctuation', '."!'],
    ['an empty quote', ''],
    ['a quote not in the text', 'Generated files are committed.'],
  ])('drops %s', (_, quote) => {
    expect(verifiedQuote(quote, SHOWN)).toBeNull();
  });

  it('drops any quote when no text was shown', () => {
    expect(verifiedQuote('Generated files', null)).toBeNull();
  });

  it('counts no stripped punctuation towards a long enough quote', () => {
    // 19 characters once the added period is stripped: one short of the minimum, which the period would make up.
    expect(longEnoughQuote('Gen files are in sr.')).toBe(true);
    expect(longEnoughQuote(verifiedQuote('Gen files are in sr.', 'Gen files are in sr') ?? '')).toBe(false);
  });
});
