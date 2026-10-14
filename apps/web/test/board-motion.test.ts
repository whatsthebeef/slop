import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { describeRemote } from '../src/lib/board-motion';

const glob = (over: Partial<GlobView>): GlobView =>
  ({
    list: 'doing',
    status: 'implementing',
    implementer: null,
    currentRun: null,
    ...over,
  }) as GlobView;
const run = (purpose?: 'investigate') => ({ state: 'active', purpose }) as GlobView['currentRun'];

describe('describeRemote', () => {
  it('says merged for a merge that went through slop, and names GitHub only when it skipped slop', () => {
    expect(describeRemote(glob({ status: 'merging' }), glob({ list: 'reviewing' })).text).toBe(
      'merged',
    );
    expect(describeRemote(glob({ status: 'pr_open' }), glob({ list: 'reviewing' })).text).toBe(
      'merged on GitHub',
    );
  });
  it('words the other column moves', () => {
    expect(describeRemote(glob({}), glob({ list: 'signed_off' })).text).toBe('signed off');
    expect(describeRemote(glob({}), glob({ list: 'planning' })).text).toBe('back to planning');
    expect(describeRemote(glob({}), glob({})).text).toBe('moved');
  });
  it('shows who picked it up', () => {
    expect(describeRemote(glob({}), glob({ implementer: 'john.bower@x.com' }))).toEqual({
      text: 'picked up by JB',
      icon: 'human',
    });
  });
  it('says the machine started, never routine', () => {
    expect(describeRemote(glob({}), glob({ currentRun: run() }))).toEqual({
      text: 'machine started',
      icon: 'machine',
    });
    expect(describeRemote(glob({}), glob({ currentRun: run('investigate') })).text).toBe(
      'investigating',
    );
  });
});
