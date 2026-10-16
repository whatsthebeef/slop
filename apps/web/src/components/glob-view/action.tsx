import { HumanIcon, MachineIcon } from '../actor-icons';
import type { GlobViewContext } from './context';
import { InlineMarkdown } from '../markdown-view';
import { CommandBox } from '../human-steps';
import { actionLine } from '@slop/core';

/** The action section: who is meant to do an action glob and, once it ended, who finished it, when, and the note or reason. Nothing for other globs. */
export const ActionOutcome = ({ ctx: { glob } }: { ctx: GlobViewContext }) => {
  const action = glob.category === 'action' && glob.attributes !== undefined && 'assignee' in glob.attributes ? glob.attributes : null;
  if (action === null) return null;
  const { outcome } = action;
  // A prepared action: the machine writes what the person runs; its state, rounds and the commands to run.
  const line = actionLine(glob);
  const rounds = glob.preparation?.rounds ?? action.preparation?.rounds ?? null;
  const commands = line?.state === 'ready' ? (glob.humanSteps ?? []).flatMap((s) => (s.kind === 'action' ? (s.commands ?? []) : [])) : [];
  return (
    <section className="grid gap-1 rounded border p-3 text-sm" aria-label="Action" data-testid="action-section">
      <div className="flex items-center gap-1.5 font-medium" data-testid="action-heading">
        {line === null ? (
          <HumanIcon decorative />
        ) : line.icon === 'human' ? (
          <HumanIcon decorative />
        ) : (
          <MachineIcon working={line.icon === 'machine-spinning'} decorative />
        )}
        {line !== null && outcome === null
          ? line.text
          : outcome === null
            ? 'A person does this, then marks it done'
            : outcome.kind === 'done'
              ? 'Done'
              : 'Dismissed'}
      </div>
      {line !== null && outcome === null && (
        <p className="text-xs text-muted-foreground" data-testid="action-state-tip">
          {line.tip}
          {rounds === null ? '' : ` (preparation round ${String(rounds)})`}
        </p>
      )}
      {commands.length > 0 && (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1" data-testid="action-commands">
          <span className="text-[11px] text-muted-foreground">Run</span>
          {commands.map((command, i) => (
            <CommandBox key={`${String(i)}:${command}`} command={command} />
          ))}
        </div>
      )}
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
