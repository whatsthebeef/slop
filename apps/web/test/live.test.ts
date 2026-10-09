import { describe, expect, it } from 'vitest';
import { reconnectDelay } from '../src/lib/live';

describe('reconnectDelay', () => {
  it('doubles from one second', () => {
    expect([0, 1, 2, 3].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000]);
  });

  it('stops growing at thirty seconds', () => {
    expect(reconnectDelay(5)).toBe(30_000);
    expect(reconnectDelay(50)).toBe(30_000);
  });
});
