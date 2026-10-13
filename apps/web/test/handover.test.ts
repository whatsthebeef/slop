import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handover } from '@slop/core';
import {
  handoverConfirmation,
  handoverOneLine,
  handoverSignature,
  handoverToShow,
  readHandoverAcknowledged,
  writeHandoverAcknowledged,
} from '../src/lib/handover';

const brief: Handover = {
  why: ['Conflicts with main: glob-dialog.tsx.', 'Failed checks on abc1234.'],
  next: 'Merge origin/main, resolve, run the checks, push.',
  detail: ['CI: https://example.test/run/1'],
};

afterEach(() => vi.unstubAllGlobals());

describe('handoverToShow', () => {
  it('shows to the implementer', () => {
    expect(handoverToShow({ handover: brief, implementer: 'a@b.c', allowedActions: [] })).toBe(brief);
  });

  it('shows to anyone who can pick up, take over or start', () => {
    for (const action of ['pick_up', 'take_over', 'start', 'start_anyway'] as const) {
      expect(handoverToShow({ handover: brief, implementer: null, allowedActions: [action] })).toBe(brief);
    }
  });

  it('stays hidden for others, and with no brief (null or an older API)', () => {
    expect(handoverToShow({ handover: brief, implementer: null, allowedActions: ['merge'] })).toBeNull();
    expect(handoverToShow({ handover: null, implementer: 'a@b.c', allowedActions: ['pick_up'] })).toBeNull();
    expect(handoverToShow({ implementer: 'a@b.c' })).toBeNull();
  });
});

describe('brief text', () => {
  it('collapses to the first cause with a count of the rest', () => {
    expect(handoverOneLine(brief)).toBe('Conflicts with main: glob-dialog.tsx. (+1 more)');
    expect(handoverOneLine({ ...brief, why: ['Only one.'] })).toBe('Only one.');
  });

  it('says why in the confirmation', () => {
    expect(handoverConfirmation('take_over', brief)).toBe(
      "You're taking over because: Conflicts with main: glob-dialog.tsx. Failed checks on abc1234. First: Merge origin/main, resolve, run the checks, push.",
    );
    expect(handoverConfirmation('pick_up', brief)).toContain("You're picking this up because:");
  });
});

describe('acknowledgement', () => {
  const stub = () => {
    const data = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) },
    });
  };

  it('is remembered per glob, and forgotten when the situation changes', () => {
    stub();
    expect(readHandoverAcknowledged('s1t1', brief)).toBe(false);
    writeHandoverAcknowledged('s1t1', brief);
    expect(readHandoverAcknowledged('s1t1', brief)).toBe(true);
    expect(readHandoverAcknowledged('s1t2', brief)).toBe(false);
    expect(readHandoverAcknowledged('s1t1', { ...brief, next: 'Something else.' })).toBe(false);
    expect(handoverSignature(brief)).not.toBe(handoverSignature({ ...brief, why: [] }));
    writeHandoverAcknowledged('s1t1', null);
    expect(readHandoverAcknowledged('s1t1', brief)).toBe(false);
  });

  it('survives storage that throws', () => {
    const boom = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('window', { localStorage: { getItem: boom, setItem: boom } });
    expect(readHandoverAcknowledged('s1t1', brief)).toBe(false);
    expect(() => writeHandoverAcknowledged('s1t1', brief)).not.toThrow();
  });
});
