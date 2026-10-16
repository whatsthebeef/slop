import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { cardMoves } from '../src/lib/card-moves';
import { glob } from '../../../packages/core/test/fixtures';

const planning = (patch: Partial<GlobView> = {}): GlobView =>
  ({ ...glob(), status: 'planning', list: 'planning', provisioning: 'ok', implementer: null, ...patch }) as GlobView;
const actions = (g: GlobView) => cardMoves(g).map((m) => m.move.action);

describe('card moves', () => {
  it('a sub in Planning offers Start only, never Start now, Retry or Take over beside it', () => {
    expect(actions(planning({ type: 'sub', allowedActions: ['start', 'start_anyway', 'pick_up', 'take_over', 'retrigger'] }))).toEqual(['start']);
  });

  it('a same in Planning offers Start and Pick up', () => {
    expect(actions(planning({ type: 'same', allowedActions: ['start', 'start_anyway', 'pick_up', 'retrigger'] }))).toEqual(['start', 'pick_up']);
  });

  it('a super offers Pick up only', () => {
    expect(actions(planning({ type: 'super', allowedActions: ['start', 'pick_up'] }))).toEqual(['pick_up']);
  });

  it('take over shows as the one Pick up', () => {
    const moves = cardMoves(planning({ type: 'same', allowedActions: ['start', 'pick_up', 'take_over'] }));
    expect(moves.map((m) => m.move.label)).toEqual(['Start ▸', 'Pick up ▸']);
    expect(moves.map((m) => m.move.action)).toEqual(['start', 'take_over']);
  });

  it('falls back to the next common action when Start is not allowed', () => {
    expect(actions(planning({ type: 'sub', allowedActions: ['start_anyway', 'retrigger', 'pick_up'] }))).toEqual(['retrigger']);
    expect(actions(planning({ type: 'sub', allowedActions: ['start_anyway'] }))).toEqual([]);
  });

  it('never offers Merge anyway or Sign off anyway on a card', () => {
    expect(actions(planning({ list: 'reviewing', status: 'pr_open', allowedActions: ['merge_anyway', 'pick_up'] }))).toEqual([]);
    expect(actions(planning({ list: 'reviewing', status: 'reviewing', allowedActions: ['sign_off_anyway'] }))).toEqual([]);
  });

  it('has no moves outside Planning or while the branch is being created', () => {
    expect(actions(planning({ list: 'doing', status: 'implementing', allowedActions: ['retrigger', 'start_anyway'] }))).toEqual([]);
    expect(actions(planning({ provisioning: 'pending', allowedActions: ['start'] }))).toEqual([]);
  });

  describe('Fix conflict outside Planning', () => {
    const doing = (patch: Partial<GlobView> = {}): GlobView =>
      planning({ list: 'doing', status: 'pr_open', type: 'sub', allowedActions: ['resolve_conflict', 'merge', 'take_over'], ...patch });

    it('offers it in place, with a confirming second click, when it is the glob view\'s main action', () => {
      const [fix, ...rest] = cardMoves(doing());
      expect(rest).toEqual([]);
      expect(fix?.move).toMatchObject({ action: 'resolve_conflict', direction: 'none', confirm: true, label: 'Fix conflict' });
      expect(fix?.target).toBe('doing');
    });

    it('offers nothing when the main action is something else, or Fix conflict is not allowed', () => {
      expect(actions(doing({ allowedActions: ['merge', 'take_over'] }))).toEqual([]);
      expect(actions(doing({ status: 'implementing', type: 'same', allowedActions: ['take_over'] }))).toEqual([]);
      expect(actions(doing({ provisioning: 'pending' }))).toEqual([]);
    });

    it('keeps Planning moves as they were', () => {
      const moves = cardMoves(planning({ type: 'sub', allowedActions: ['start', 'resolve_conflict'] }));
      expect(moves.map((m) => [m.move.action, m.move.direction, m.move.confirm])).toEqual([['start', 'right', false]]);
    });
  });
});
