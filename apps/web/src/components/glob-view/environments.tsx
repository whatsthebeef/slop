import { decisionOf } from '@slop/core';
import { EnvironmentsSection } from '../deploys';
import type { GlobViewContext } from './context';

/** The environments section; a decision glob has none. */
export const EnvironmentsPanel = ({ ctx }: { ctx: GlobViewContext }) =>
  decisionOf(ctx.glob) === null ? <EnvironmentsSection board={ctx.board} glob={ctx.glob} /> : null;
