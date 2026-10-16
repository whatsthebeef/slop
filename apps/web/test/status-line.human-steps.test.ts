import { describe, expect, it } from 'vitest';
import { statusLine } from '@slop/core';
import { NOW, glob } from '../../../packages/core/test/fixtures';
import { head, prOpen, view } from './helpers/glob-views';

describe('your turn from human steps', () => {
  const dev = { email: 'dev@example.com', role: 'dev' } as const;
  const step = (patch = {}) =>
    ({
      id: 'hs-1',
      kind: 'rollout',
      title: 'Deploy the host stack',
      state: 'due',
      who: 'admin',
      due: 'now',
      blocks: [],
      ...patch,
    }) as const;

  it('a stalled glob shows its action as the label and the cause in the tooltip', () => {
    const stalled = view({
      status: 'in_progress',
      list: 'doing',
      move: {
        holder: 'stalled',
        cause: 'quiet',
        reason: 'implement: no progress for 60 min',
        since: null,
      },
      humanSteps: [
        step({
          id: 'machine:unstick',
          kind: 'unstick',
          title: 'Open session',
          who: 'implementer',
          action: 'open_session',
          alternative: 'pick_up',
        }),
      ],
    });
    const line = statusLine(stalled, NOW, { email: glob().planner, role: 'dev' });
    expect(line).toMatchObject({
      kind: 'ready',
      text: 'Open session',
      turn: 'unstick',
      action: 'open_session',
    });
    expect(line?.tip).toContain('Implement: no progress for 60 min');
    expect(line?.tip).toContain('glob view');
  });

  it('cuts a long step title to one line for the chip, keeping the whole in the tooltip', () => {
    const long = view({
      status: 'reviewing',
      humanSteps: [
        step({ title: 'Tell the whole team about the new deploy process', who: 'admin' }),
      ],
    });
    const line = statusLine(long, NOW, { email: 'admin@example.com', role: 'admin' });
    expect(line?.text.length).toBeLessThanOrEqual(24);
    expect(line?.tip).toBe('Tell the whole team about the new deploy process');
  });

  it('shows the first due step for the viewer, with the Merge tip for a merge step', () => {
    const merge = prOpen({
      headChecks: { sha: head, state: 'passed' },
      humanSteps: [
        { ...step({ id: 'machine:merge', kind: 'merge', title: 'Merge', who: 'anyone' }) },
      ],
    });
    const line = statusLine(merge, NOW, dev);
    expect(line).toMatchObject({ kind: 'ready', text: 'Merge' });
    expect(line?.tip).toContain('checks passed');
    const rollout = view({
      status: 'reviewing',
      humanSteps: [
        step({ who: 'admin' }),
        step({ id: 'hs-2', who: 'implementer', title: 'Tell the team' }),
      ],
    });
    expect(statusLine(rollout, NOW, { email: glob().planner, role: 'dev' })).toMatchObject({
      kind: 'ready',
      text: 'do',
    });
    expect(statusLine(rollout, NOW, { email: 'admin@example.com', role: 'admin' })).toMatchObject({
      kind: 'ready',
      text: 'do',
    });
  });

  it('is not your turn for a pending step or one that is for someone else', () => {
    expect(statusLine(view({ humanSteps: [step({ state: 'pending' })] }), NOW, dev)).toBeNull();
    expect(statusLine(view({ humanSteps: [step({ who: 'admin' })] }), NOW, dev)).toBeNull();
  });

  it('falls back to the Merge turn when the API sends no steps', () => {
    const merge = prOpen({ headChecks: { sha: head, state: 'passed' } });
    expect(statusLine(merge, NOW, dev)).toMatchObject({ kind: 'ready', text: 'Merge' });
  });
});
