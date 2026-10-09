import { describe, expect, it } from 'vitest';
import type { KbItem } from '@slop/core';
import { decidedByAgent, reopenable } from '../src/lib/kb-agent-decisions';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const day = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * day).toISOString();

const item = (id: string, patch: Partial<KbItem>): KbItem => ({ id, status: 'approved', decidedAt: at(1), outcome: null, ...patch }) as KbItem;
const byAgent = { kind: 'learning', via: 'agent' } as const;

describe('Decided by agent (last 7 days)', () => {
  it('keeps approvals and rejections an agent made within a week, newest first', () => {
    const items = [
      item('old', { outcome: byAgent, decidedAt: at(8) }),
      item('person', { outcome: { kind: 'learning' }, decidedAt: at(1) }),
      item('rejectedByPerson', { status: 'rejected', outcome: null, decidedAt: at(1) }),
      item('a', { outcome: byAgent, decidedAt: at(5) }),
      item('b', { status: 'rejected', outcome: { kind: 'rejected', via: 'agent' }, decidedAt: at(2) }),
    ];
    expect(decidedByAgent(items, NOW).map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('includes a decision exactly a week old and skips items without a decision time', () => {
    const items = [item('edge', { outcome: byAgent, decidedAt: at(7) }), item('none', { outcome: byAgent, decidedAt: null })];
    expect(decidedByAgent(items, NOW).map((i) => i.id)).toEqual(['edge']);
  });

  it('can reopen what the pipeline closed and what an agent decided, not a person\'s decision', () => {
    expect(reopenable(item('m', { status: 'merged' }))).toBe(true);
    expect(reopenable(item('a', { outcome: byAgent }))).toBe(true);
    expect(reopenable(item('r', { status: 'rejected', outcome: { kind: 'rejected', via: 'agent' } }))).toBe(true);
    expect(reopenable(item('p', { outcome: { kind: 'learning' } }))).toBe(false);
    expect(reopenable(item('o', { status: 'open' }))).toBe(false);
  });
});
