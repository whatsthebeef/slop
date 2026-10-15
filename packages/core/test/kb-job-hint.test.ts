import { describe, expect, it } from 'vitest';
import { kbJobHint, suggestJobHint } from '../src/index.js';

describe('job hints', () => {
  it('tells the glob to refetch when a recommendation job settles without storing one', () => {
    expect(suggestJobHint({ kind: 'suggest_decision', globId: 's1k4' })).toEqual({ kind: 'glob.artifacts', boardId: 1, globId: 's1k4' });
  });

  it('leaves other jobs to their own hints', () => {
    expect(suggestJobHint({ kind: 'kb_route', globId: 's1k4' })).toBeNull();
    expect(kbJobHint({ kind: 'suggest_decision', globId: 's1k4' })).toBeNull();
  });
});
