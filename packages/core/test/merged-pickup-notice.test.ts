import { describe, expect, it } from 'vitest';
import { mergedPickUpNotice } from '../src/domain/handover.js';

const glob = (patch = {}) => ({ id: 's14b4', status: 'reviewing' as const, labels: {}, ...patch });

describe('mergedPickUpNotice', () => {
  it('names a due step, a pending QA label, the link and the follow-up', () => {
    const text = mergedPickUpNotice(glob({ labels: { QA: 'required', CR: 'approved' } }), [
      { title: 'Roll out the host stack', who: 'admin', state: 'due' },
      { title: 'Old', who: 'anyone', state: 'done' },
    ]);
    expect(text).toContain('s14b4 is already merged (reviewing)');
    expect(text).toContain('- Roll out the host stack (admin, due)');
    expect(text).not.toContain('Old');
    expect(text).toContain('/globs/s14b4?section=human-steps');
    expect(text).toContain('QA (required)');
    expect(text).not.toContain('CR');
    expect(text).toContain('sstor --new');
  });

  it('says nothing is left but sign-off', () => {
    const text = mergedPickUpNotice(glob(), []);
    expect(text).toContain('nothing but sign-off');
    expect(text).toContain('sstor --new');
  });
});
