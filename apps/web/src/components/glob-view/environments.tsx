import { isHumanCategory } from '@slop/core';
import { EnvironmentsSection } from '../deploys';
import type { GlobViewContext } from './context';

/** The environments section; human work (a decision, an action) has none. */
export const EnvironmentsPanel = ({ ctx }: { ctx: GlobViewContext }) =>
  !isHumanCategory(ctx.glob.category) ? <EnvironmentsSection board={ctx.board} glob={ctx.glob} /> : null;
