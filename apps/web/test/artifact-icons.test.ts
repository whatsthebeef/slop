import { SearchCheck } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_META } from '../src/components/artifacts';
import { CATEGORY_ICON } from '../src/components/glob-card';

describe('artifact icons', () => {
  it('gives every artifact kind its own icon, apart from the postplan alias and the review pair', () => {
    const kinds = Object.keys(ARTIFACT_META).filter(
      (k) => k !== 'postplan' && k !== 'local_review',
    ) as (keyof typeof ARTIFACT_META)[];
    const icons = kinds.map((k) => ARTIFACT_META[k].icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('gives both reviews the magnifying-glass icon', () => {
    expect(ARTIFACT_META.local_review.icon).toBe(SearchCheck);
    expect(ARTIFACT_META.independent_review.icon).toBe(SearchCheck);
  });

  it('never uses a category icon for an artifact kind', () => {
    const categoryIcons = new Set(Object.values(CATEGORY_ICON).map((c) => c.icon));
    for (const [kind, meta] of Object.entries(ARTIFACT_META)) {
      expect(categoryIcons.has(meta.icon), kind).toBe(false);
    }
  });

  it('lets the postplan alias share the implementation record icon', () => {
    expect(ARTIFACT_META.postplan.icon).toBe(ARTIFACT_META.implementation_plan.icon);
  });
});
