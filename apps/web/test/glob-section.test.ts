import { describe, expect, it } from 'vitest';
import { globPath, globQuery, globTargetOf, parseGlobTarget } from '@/lib/glob-section';

const parse = (query: string) => parseGlobTarget(new URLSearchParams(query));

describe('parseGlobTarget', () => {
  it('reads section, artifact and label', () => {
    expect(parse('section=artifacts&artifact=attachment&label=Decisions')).toEqual({ section: 'artifacts', artifact: 'attachment', label: 'Decisions' });
  });
  it('keeps an artifact without a section (older links)', () => {
    expect(parse('artifact=independent_review')).toEqual({ section: null, artifact: 'independent_review', label: null });
  });
  it('ignores an unknown or empty section', () => {
    expect(parse('section=nope').section).toBeNull();
    expect(parse('section=').section).toBeNull();
    expect(parse('').section).toBeNull();
  });
});

describe('globPath', () => {
  it('is the plain page path without a target', () => {
    expect(globPath(15, 's15f94')).toBe('/boards/15/globs/s15f94');
  });
  it('carries section, artifact and label', () => {
    expect(globPath(15, 's15f94', { section: 'labels', label: 'CR' })).toBe('/boards/15/globs/s15f94?section=labels&label=CR');
    expect(globPath(15, 's15f94', { section: 'artifacts', artifact: 'attachment', label: 'A b' })).toBe(
      '/boards/15/globs/s15f94?section=artifacts&artifact=attachment&label=A+b',
    );
  });
  it('round-trips through parseGlobTarget', () => {
    const target = { section: 'findings' as const, artifact: 'independent_review' };
    expect(parse(globQuery(target))).toEqual({ ...target, label: null });
  });
});

describe('globTargetOf', () => {
  it('passes section, artifact and label on and drops unknown sections', () => {
    expect(globTargetOf(new URLSearchParams('glob=s1t1&section=labels&label=CR&x=1'))).toEqual({ section: 'labels', label: 'CR' });
    expect(globTargetOf(new URLSearchParams('glob=s1t1&section=nope'))).toEqual({});
  });
});
