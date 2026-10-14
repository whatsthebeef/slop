import { PlanEditor } from '../plan-editor';
import type { GlobViewContext } from './context';

/** The plan section. Its header's version dropdown switches the preview between versions. */
export const PlanSection = ({ ctx }: { ctx: GlobViewContext }) => (
  <PlanEditor
    globId={ctx.glob.id}
    startExpanded={new URLSearchParams(window.location.search).get('section') === 'plan'}
  />
);
