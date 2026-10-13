import { describe, expect, it } from 'vitest';
import { ARTIFACT_META } from '../src/components/artifacts';

describe('artifact icons', () => {
  it('gives every artifact kind its own icon, apart from the postplan alias of the record', () => {
    const kinds = Object.keys(ARTIFACT_META).filter(
      (k) => k !== 'postplan',
    ) as (keyof typeof ARTIFACT_META)[];
    const icons = kinds.map((k) => ARTIFACT_META[k].icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('lets the postplan alias share the implementation record icon', () => {
    expect(ARTIFACT_META.postplan.icon).toBe(ARTIFACT_META.implementation_plan.icon);
  });
});
