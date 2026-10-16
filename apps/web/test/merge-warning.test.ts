import { describe, expect, it } from 'vitest';
import { mergeWarning } from '@slop/core';
import { NOW } from '../../../packages/core/test/fixtures';
import { prOpen, view } from './helpers/glob-views';

describe('mergeWarning', () => {
  const behind = { base: 'main', behindBy: 2, files: ['a.ts'], at: NOW };
  it('warns on a pr_open glob whose base moved with no conflict recorded', () => {
    expect(mergeWarning(prOpen({ behind }))).toContain('main has moved since the checks ran');
  });
  it('says nothing when the branch is level, a conflict is recorded, or the glob is not in review', () => {
    expect(mergeWarning(prOpen({ behind: { ...behind, behindBy: 0 } }))).toBeNull();
    expect(mergeWarning(prOpen())).toBeNull();
    expect(mergeWarning(prOpen({ behind, conflict: { base: 'main', files: [], since: null, at: NOW } }))).toBeNull();
    expect(mergeWarning(view({ status: 'in_progress', behind }))).toBeNull();
  });
});
