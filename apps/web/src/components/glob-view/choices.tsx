import { GlobDecisions } from '../glob-decisions';
import type { GlobViewContext } from './context';

/** The choices section: the decisions taken on this glob. */
export const ChoicesPanel = ({ ctx }: { ctx: GlobViewContext }) => (
  <GlobDecisions boardId={ctx.glob.boardId} globId={ctx.glob.id} />
);
