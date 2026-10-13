import { PlanEditor } from '../plan-editor';
import type { GlobViewContext } from './context';

/** The plan section. `onHistory` opens the plan's version history in the artifacts section. */
export const PlanSection = ({
  ctx,
  onHistory,
}: {
  ctx: GlobViewContext;
  onHistory: () => void;
}) => (
  <PlanEditor
    globId={ctx.glob.id}
    startExpanded={new URLSearchParams(window.location.search).get('section') === 'plan'}
    onHistory={ctx.glob.status === 'signed_off' ? undefined : onHistory}
  />
);
