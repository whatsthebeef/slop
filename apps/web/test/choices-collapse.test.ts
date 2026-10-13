import type { DecisionView } from '@slop/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultOpen, hintCount, MAX_OPEN_CHOICES, readChoicesOpen, writeChoicesOpen } from '../src/lib/choices-collapse';

const choice = (over: Partial<DecisionView> = {}): DecisionView => ({ replacedBy: null, replaces: [], ...over }) as DecisionView;
const many = (n: number) => Array.from({ length: n }, () => choice());
const hinted = choice({ replaces: [{ state: 'hint' } as DecisionView['replaces'][number]] });

const store = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal('window', {
    localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) },
  });
  return data;
};

afterEach(() => vi.unstubAllGlobals());

describe('Choices section collapse', () => {
  it('starts open for a few choices and collapsed for more', () => {
    expect(defaultOpen(many(MAX_OPEN_CHOICES))).toBe(true);
    expect(defaultOpen(many(MAX_OPEN_CHOICES + 1))).toBe(false);
  });

  it('starts collapsed when any replacement is pending, and counts those choices', () => {
    const proposed = choice({ replacedBy: { state: 'hint' } as DecisionView['replacedBy'] });
    expect(hintCount([choice(), hinted, proposed])).toBe(2);
    expect(defaultOpen([hinted])).toBe(false);
    expect(hintCount(many(2))).toBe(0);
  });

  it('remembers the viewer\'s toggle, which is null until one is made', () => {
    store();
    expect(readChoicesOpen()).toBeNull();
    writeChoicesOpen(false);
    expect(readChoicesOpen()).toBe(false);
    writeChoicesOpen(true);
    expect(readChoicesOpen()).toBe(true);
  });

  it('ignores unusable values and works when storage throws', () => {
    store({ 'slop.choices-open': 'maybe' });
    expect(readChoicesOpen()).toBeNull();
    const boom = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('window', { localStorage: { getItem: boom, setItem: boom } });
    expect(readChoicesOpen()).toBeNull();
    expect(() => writeChoicesOpen(true)).not.toThrow();
  });
});
