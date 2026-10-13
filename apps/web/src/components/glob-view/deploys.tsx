import { decisionOf } from '@slop/core';
import { DeploysSection } from '../deploys';
import type { GlobViewContext } from './context';

/** The deploys section; a decision glob has none. */
export const DeploysPanel = ({ ctx }: { ctx: GlobViewContext }) =>
  decisionOf(ctx.glob) === null ? <DeploysSection board={ctx.board} glob={ctx.glob} /> : null;
