import { describe, expect, it } from 'vitest';
import { SIGNED_OFF_ON_BOARD, bySignedOffNewest, latestSignedOff } from '../src/index.js';

const at = (n: number) => ({
  id: `s1t${n}`,
  signedOffAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
});

describe('latestSignedOff', () => {
  it('keeps the 25 most recently signed off, newest first', () => {
    const all = Array.from({ length: 30 }, (_, i) => at(i + 1));
    const kept = latestSignedOff(all);
    expect(kept).toHaveLength(SIGNED_OFF_ON_BOARD);
    expect(kept[0]?.id).toBe('s1t30');
    expect(kept.at(-1)?.id).toBe('s1t6');
  });

  it('orders by signedOffAt, with unsigned ones last', () => {
    const sorted = bySignedOffNewest([{ id: 'a', signedOffAt: null }, at(1), at(2)]);
    expect(sorted.map((g) => g.id)).toEqual(['s1t2', 's1t1', 'a']);
  });
});
