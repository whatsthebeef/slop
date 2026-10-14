import { describe, expect, it } from 'vitest';
import {
  SIGNED_OFF_ON_BOARD,
  byListSinceNewest,
  bySignedOffNewest,
  latestSignedOff,
} from '../src/index.js';

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

describe('byListSinceNewest', () => {
  const g = (id: string, createdAt: string, listSince?: string) => ({
    id,
    createdAt,
    ...(listSince && { listSince }),
  });

  it('orders by when the glob entered the list, newest first, falling back to createdAt', () => {
    const sorted = byListSinceNewest([
      g('s1t1', '2026-01-03T00:00:00Z'),
      g('s1t2', '2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z'),
      g('s1t3', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['s1t2', 's1t1', 's1t3']);
  });

  it('breaks ties by ID, descending', () => {
    const t = '2026-01-01T00:00:00Z';
    expect(
      byListSinceNewest([g('s1t9', t, t), g('s1t160', t, t), g('s1t20', t, t)]).map((x) => x.id),
    ).toEqual(['s1t160', 's1t20', 's1t9']);
  });
});
