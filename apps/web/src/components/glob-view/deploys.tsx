import { isHumanCategory } from '@slop/core';
import { DeploysSection } from '../deploys';
import type { GlobViewContext } from './context';

/** The deploys section; human work (a decision, an action) has none. */
export const DeploysPanel = ({ ctx }: { ctx: GlobViewContext }) =>
  !isHumanCategory(ctx.glob.category) ? <DeploysSection glob={ctx.glob} /> : null;
