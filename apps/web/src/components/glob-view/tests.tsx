import { decisionOf } from '@slop/core';
import { TestsSection } from '../deploys';
import type { GlobViewContext } from './context';

/** The tests section; a decision glob has none. */
export const TestsPanel = ({ ctx }: { ctx: GlobViewContext }) =>
  decisionOf(ctx.glob) === null ? <TestsSection glob={ctx.glob} /> : null;
