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

  it('has no moves outside Planning or while the branch is being created', () => {
    expect(actions(planning({ list: 'doing', status: 'implementing', allowedActions: ['retrigger', 'start_anyway'] }))).toEqual([]);
    expect(actions(planning({ provisioning: 'pending', allowedActions: ['start'] }))).toEqual([]);
  });
});
