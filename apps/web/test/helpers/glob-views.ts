import type { GlobView } from '../../src/lib/api';
import { glob } from '../../../../packages/core/test/fixtures';

export const head = 'd16d563aaaa';
export const view = (patch: Partial<GlobView> = {}): GlobView =>
  ({ ...glob(), ...patch }) as GlobView;
export const prOpen = (patch: Partial<GlobView> = {}) =>
  view({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: head }, ...patch });
export const failedChecks = {
  sha: head,
  state: 'failed' as const,
  failure: {
    name: 'Type check',
    step: null,
    lines: ['packages/core typecheck: TS2322 not assignable'],
    url: 'https://github.com/x/y/actions/runs/1',
  },
};
export const hold = (
  to: string,
  patch: Partial<NonNullable<GlobView['holding']>[number]> = {},
): NonNullable<GlobView['holding']>[number] => ({
  relationId: `rel_${to}`,
  to,
  toTitle: null,
  toIsDecision: false,
  gate: 'start',
  until: 'merged',
  state: 'open',
  reason: null,
  source: 'person',
  ...patch,
});
