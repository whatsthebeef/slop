import { describe, expect, it } from 'vitest';
import type { Handover } from '@slop/core';
import {
  handoverConfirmation,
  handoverOneLine,
  handoverSignature,
  handoverToShow,
} from '../src/lib/handover';

const brief: Handover = {
  why: ['Conflicts with main: glob-dialog.tsx.', 'Failed checks on abc1234.'],
  next: 'Merge origin/main, resolve, run the checks, push.',
  detail: ['CI: https://example.test/run/1'],
};

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

describe('signature', () => {
  it('changes when the causes or the first step do', () => {
    expect(handoverSignature(brief)).toBe(handoverSignature({ ...brief, detail: [] }));
    expect(handoverSignature(brief)).not.toBe(handoverSignature({ ...brief, next: 'Something else.' }));
    expect(handoverSignature(brief)).not.toBe(handoverSignature({ ...brief, why: [] }));
  });
});
