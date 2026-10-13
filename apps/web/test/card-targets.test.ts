import { describe, expect, it } from 'vitest';
import { cardTargets } from '../src/lib/card-targets';
import { globPath } from '../src/lib/glob-section';

const path = (target: ReturnType<(typeof cardTargets)[keyof typeof cardTargets]>) => globPath(15, 's15f1', target);

describe('cardTargets', () => {
  it('opens an artifact icon at the artifacts section with that artifact', () => {
    expect(path(cardTargets.artifact('implementation_plan'))).toBe('/boards/15/globs/s15f1?section=artifacts&artifact=implementation_plan');
  });

  it('opens the review status at the findings section', () => {
    expect(path(cardTargets.findings())).toBe('/boards/15/globs/s15f1?section=findings');
  });

  it('opens the chips at their sections', () => {
    expect(path(cardTargets.prerequisites())).toBe('/boards/15/globs/s15f1?section=prerequisites');
    expect(path(cardTargets.escalation())).toBe('/boards/15/globs/s15f1?section=escalation');
    expect(path(cardTargets.conflict())).toBe('/boards/15/globs/s15f1?section=conflict');
    expect(path(cardTargets.size())).toBe('/boards/15/globs/s15f1?section=size');
    expect(path(cardTargets.decision())).toBe('/boards/15/globs/s15f1?section=decision');
    expect(path(cardTargets.deploys())).toBe('/boards/15/globs/s15f1?section=deploys');
  });

  it('opens a label at the labels section with its name, or the whole section without one', () => {
    expect(path(cardTargets.label('CR'))).toBe('/boards/15/globs/s15f1?section=labels&label=CR');
    expect(path(cardTargets.label())).toBe('/boards/15/globs/s15f1?section=labels');
  });
});
