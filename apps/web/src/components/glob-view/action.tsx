import { HumanIcon } from '../actor-icons';
import type { GlobViewContext } from './context';
import { InlineMarkdown } from '../markdown-view';

/** The action section: who is meant to do an action glob and, once it ended, who finished it, when, and the note or reason. Nothing for other globs. */
export const ActionOutcome = ({ ctx: { glob } }: { ctx: GlobViewContext }) => {
  const action = glob.category === 'action' && glob.attributes !== undefined && 'assignee' in glob.attributes ? glob.attributes : null;
  if (action === null) return null;
  const { outcome } = action;
  return (
    <section className="grid gap-1 rounded border p-3 text-sm" aria-label="Action" data-testid="action-section">
      <div className="flex items-center gap-1.5 font-medium">
        <HumanIcon decorative />
        {outcome === null ? 'A person does this, then marks it done' : outcome.kind === 'done' ? 'Done' : 'Dismissed'}
      </div>
      {outcome === null ? (
        <p className="text-xs text-muted-foreground" data-testid="action-assignee">
          {action.assignee === null ? 'Anyone on the board can do it.' : `Assigned to ${action.assignee}.`}
        </p>
      ) : (
        <div className="text-xs text-muted-foreground" data-testid="action-outcome">
          {outcome.kind === 'done' ? 'Done' : 'Dismissed'} by {outcome.by} on {new Date(outcome.at).toLocaleDateString()}
          {outcome.note === undefined && outcome.reason === undefined ? null : (
            <>
              : <InlineMarkdown text={outcome.note ?? outcome.reason ?? ''} />
            </>
          )}
        </div>
      )}
    </section>
  );
};
