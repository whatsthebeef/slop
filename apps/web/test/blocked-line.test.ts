import { describe, expect, it } from 'vitest';
import { blockedParts, chainTip, holdLine } from '@slop/core';
import { hold, prOpen, view } from './helpers/glob-views';

describe('blocked parts', () => {
  const ahead = (ids: string[]) => view({ status: 'planning', holding: ids.map((id) => hold(id)) });

  it('names one or two blockers', () => {
    expect(blockedParts(ahead(['s1t1']))).toEqual({ ids: ['s1t1'], more: 0 });
    expect(blockedParts(ahead(['s1t1', 's1t2']))).toEqual({ ids: ['s1t1', 's1t2'], more: 0 });
  });

  it('folds three or more into two names and a count', () => {
    expect(blockedParts(ahead(['s1t1', 's1t2', 's1t3']))).toEqual({ ids: ['s1t1', 's1t2', 's1t3'], more: 0 });
    expect(blockedParts(ahead(['s1t1', 's1t2', 's1t3', 's1t4']))).toEqual({ ids: ['s1t1', 's1t2'], more: 2 });
  });

  it('names a decision as such, and counts only start relations', () => {
    const g = view({
      status: 'planning',
      holding: [hold('s1k4', { toIsDecision: true, until: 'decided' }), hold('s1t7', { gate: 'merge' }), hold('s1t8', { gate: 'sign_off' })],
    });
    expect(blockedParts(g)).toEqual({ ids: ['decision s1k4'], more: 0 });
  });

  it('holds only a glob in Planning (or a failed one Retrigger would refuse)', () => {
    expect(blockedParts({ ...ahead(['s1t1']), status: 'failed' })?.ids).toEqual(['s1t1']);
    expect(blockedParts({ ...ahead(['s1t1']), status: 'in_progress' })).toBeNull();
    expect(blockedParts({ ...ahead(['s1t1']), status: 'pr_open' })).toBeNull();
  });

  it('is null with nothing ahead', () => {
    expect(blockedParts(view())).toBeNull();
    expect(blockedParts(view({ status: 'planning', holding: [] }))).toBeNull();
  });

  it('the tip says where each one stands and why', () => {
    const g = view({ status: 'planning', holding: [hold('s1t1', { state: 'planning', reason: 'uses humanSteps()' }), hold('s1k4', { toIsDecision: true, until: 'decided', state: 'planning' })] });
    expect(chainTip(g)).toBe('s1t1 (Planning): uses humanSteps(), decision s1k4 (Planning)');
  });
});

describe('holdLine', () => {
  it('is null with nothing holding the glob where it stands', () => {
    expect(holdLine(view({ status: 'planning', holding: [] }))).toBeNull();
    expect(holdLine(view({ status: 'in_progress', holding: [hold('s1t1')] }))).toBeNull();
  });

  it('says a start hold by a glob, a decision and a merge gate as only the holder\'s ID', () => {
    expect(holdLine(view({ status: 'planning', holding: [hold('s1t1')] }))).toMatchObject({ text: 's1t1', icon: 'hourglass' });
    expect(holdLine(view({ status: 'planning', holding: [hold('s1k1', { toIsDecision: true, until: 'decided' })] }))).toMatchObject({
      text: 's1k1',
      icon: 'hourglass',
    });
    expect(holdLine(prOpen({ holding: [hold('s1k1', { toIsDecision: true, gate: 'merge' })] }))?.text).toBe('s1k1');
  });

  it('names the first of several and counts the others, and the tip lists each with its reason', () => {
    const line = holdLine(view({ status: 'planning', holding: [hold('s1t1', { reason: 'a' }), hold('s1t2', { state: 'planning' }), hold('s1t3', { toIsDecision: true })] }));
    expect(line?.text).toBe('s1t1');
    expect(line?.tip.split('\n')).toEqual([
      `Waits for s1t1 to be merged and rolled out (Doing): a`,
      `Waits for s1t2 to be merged and rolled out (Planning) (no reason given)`,
      `Waits for decision s1t3 to be merged and rolled out (Doing) (no reason given)`,
    ]);
  });
});
