import { decisionOf } from '@slop/core';
import { ReviewFindings } from '../review-findings';
import type { GlobViewContext } from './context';

/** The review findings section; a decision glob has none. */
export const FindingsPanel = ({ ctx }: { ctx: GlobViewContext }) =>
  decisionOf(ctx.glob) === null ? (
    <ReviewFindings
      globId={ctx.glob.id}
      startOpen={new URLSearchParams(window.location.search).get('section') === 'findings'}
    />
  ) : null;
