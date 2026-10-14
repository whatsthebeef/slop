import { PlanEditor } from '../plan-editor';
import type { GlobViewContext } from './context';

/** The plan section. Its version history opens inline, unless sign-off moves the plan into the artifacts list. */
export const PlanSection = ({ ctx }: { ctx: GlobViewContext }) => (
  <PlanEditor
    globId={ctx.glob.id}
    startExpanded={new URLSearchParams(window.location.search).get('section') === 'plan'}
    history={ctx.glob.status !== 'signed_off'}
  />
);
