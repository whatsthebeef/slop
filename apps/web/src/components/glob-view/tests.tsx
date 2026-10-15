import { isHumanCategory } from '@slop/core';
import { TestsSection } from '../deploys';
import type { GlobViewContext } from './context';

/** The tests section; human work (a decision, an action) has none. */
export const TestsPanel = ({ ctx }: { ctx: GlobViewContext }) =>
  !isHumanCategory(ctx.glob.category) ? <TestsSection glob={ctx.glob} /> : null;
