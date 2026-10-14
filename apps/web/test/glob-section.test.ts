import { describe, expect, it } from 'vitest';
import { boardGlobHref, globPath, globQuery, globTargetOf, labelToOpen, parseGlobTarget } from '@/lib/glob-section';

const parse = (query: string) => parseGlobTarget(new URLSearchParams(query));

describe('parseGlobTarget', () => {
  it('reads section, artifact and label', () => {
    expect(parse('section=artifacts&artifact=attachment&label=Decisions')).toEqual({ section: 'artifacts', artifact: 'attachment', label: 'Decisions', tab: null });
  });
  it('keeps an artifact without a section (older links)', () => {
    expect(parse('artifact=independent_review')).toEqual({ section: null, artifact: 'independent_review', label: null, tab: null });
  });
  it('ignores an unknown or empty section', () => {
    expect(parse('section=nope').section).toBeNull();
    expect(parse('section=').section).toBeNull();
    expect(parse('').section).toBeNull();
  });
});

describe('the tab inside a section', () => {
  it('is read, written and passed on: ?section=plan&tab=test-plan', () => {
    expect(parse('section=plan&tab=test-plan')).toEqual({ section: 'plan', artifact: null, label: null, tab: 'test-plan' });
    expect(parse('section=plan&tab=').tab).toBeNull();
    expect(globPath(15, 's15f94', { section: 'plan', tab: 'test-plan' })).toBe('/boards/15/globs/s15f94?section=plan&tab=test-plan');
    expect(globQuery({ section: 'plan', tab: '' })).toBe('?section=plan');
    expect(globTargetOf(new URLSearchParams('glob=s1t1&section=plan&tab=test-plan'))).toEqual({ section: 'plan', tab: 'test-plan' });
    expect(boardGlobHref(3, 's3f1', { section: 'plan', tab: 'test-plan' })).toBe('/boards/3?glob=s3f1&section=plan&tab=test-plan');
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
    expect(parse(globQuery(target))).toEqual({ ...target, label: null, tab: null });
  });
});

describe('globTargetOf', () => {
  it('passes section, artifact and label on and drops unknown sections', () => {
    expect(globTargetOf(new URLSearchParams('glob=s1t1&section=labels&label=CR&x=1'))).toEqual({ section: 'labels', label: 'CR' });
    expect(globTargetOf(new URLSearchParams('glob=s1t1&section=nope'))).toEqual({});
  });
});

describe('boardGlobHref', () => {
  it('stays a plain glob link without a target', () => {
    expect(boardGlobHref(3, 's3f1')).toBe('/boards/3?glob=s3f1');
  });
  it('adds the section, artifact and label to the board redirect', () => {
    expect(boardGlobHref(3, 's3f1', { section: 'artifacts', artifact: 'attachment', label: 'Notes' })).toBe(
      '/boards/3?glob=s3f1&section=artifacts&artifact=attachment&label=Notes',
    );
    expect(boardGlobHref(3, 's3f1', { section: 'size' })).toBe('/boards/3?glob=s3f1&section=size');
  });
});

describe('labelToOpen', () => {
  const open = (query: string) => labelToOpen(parse(query));
  it('is the label for labels+label', () => {
    expect(open('section=labels&label=CR')).toBe('CR');
  });
  it('is none when an artifact is present', () => {
    expect(open('section=labels&artifact=attachment&label=CR')).toBeNull();
  });
  it('is none for an unknown label, another section or no label', () => {
    expect(open('section=labels&label=XX')).toBeNull();
    expect(open('section=plan&label=CR')).toBeNull();
    expect(open('section=labels')).toBeNull();
  });
});

describe('human steps section', () => {
  it('opens at human-steps, and rollout is an alias for it', () => {
    expect(parse('section=human-steps').section).toBe('human-steps');
    expect(parse('section=rollout').section).toBe('human-steps');
    expect(parse('section=runs').section).toBe('actions');
    expect(parse('section=pr').section).toBe('actions');
    expect(globPath(15, 's15f1', { section: 'human-steps' })).toBe('/boards/15/globs/s15f1?section=human-steps');
  });
});
