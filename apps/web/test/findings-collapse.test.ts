import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFindingsOpen, findingsSummary, readFindingsOpen, writeFindingsOpen } from '../src/lib/findings-collapse';

const f = (severity: 'in_scope' | 'suggestion' | 'unknown') => ({ severity });

afterEach(() => vi.unstubAllGlobals());

describe('Review findings collapse', () => {
  it('starts open only with an in-scope finding', () => {
    expect(defaultFindingsOpen([f('suggestion'), f('in_scope')])).toBe(true);
    expect(defaultFindingsOpen([f('suggestion'), f('unknown')])).toBe(false);
    expect(defaultFindingsOpen([])).toBe(false);
  });

  it('summarises counts by severity', () => {
    expect(findingsSummary([f('in_scope'), f('in_scope'), f('suggestion'), f('suggestion'), f('suggestion')])).toBe('2 in scope · 3 suggestions');
    expect(findingsSummary([f('suggestion')])).toBe('1 suggestion');
    expect(findingsSummary([f('unknown')])).toBe('');
  });

  it("remembers the viewer's toggle, null until one is made", () => {
    const data = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } });
    expect(readFindingsOpen()).toBeNull();
    writeFindingsOpen(true);
    expect(readFindingsOpen()).toBe(true);
    writeFindingsOpen(false);
    expect(readFindingsOpen()).toBe(false);
  });

  it('survives storage that throws', () => {
    const boom = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('window', { localStorage: { getItem: boom, setItem: boom } });
    expect(readFindingsOpen()).toBeNull();
    expect(() => writeFindingsOpen(true)).not.toThrow();
  });
});
