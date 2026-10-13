import { conflictByHand, conflictCommand, copySstorCommand } from '@/lib/sstor-command';
import type { GlobViewContext } from './context';

/** The conflict box: the command that starts the glob's Claude session on the merge, with the by-hand route collapsed below. */
const ConflictBox = ({
  globId,
  branch,
  base,
  canTakeOver,
}: {
  globId: string;
  branch: string;
  base: string;
  canTakeOver: boolean;
}) => {
  const command = conflictCommand(globId, canTakeOver);
  const copy = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    void (
      copySstorCommand(canTakeOver ? 'take_over' : 'pick_up', globId, clipboard) ??
      Promise.resolve(null)
    );
  };
  return (
    <div className="grid gap-1 rounded border border-edge p-2 text-sm" data-testid="conflict-box">
      <span>
        {canTakeOver ? 'Pick up and let your Claude session' : 'Let your Claude session'} merge{' '}
        {base}: it resolves additive conflicts and asks you about the rest.
      </span>
      <span className="flex items-center gap-2">
        <code
          className="block select-all whitespace-pre-wrap font-mono text-xs"
          data-testid="conflict-command"
        >
          {command}
        </code>
        <button
          type="button"
          className="rounded border px-1.5 py-0.5 text-xs hover:bg-muted"
          onClick={copy}
        >
          Copy
        </button>
      </span>
      <details data-testid="conflict-by-hand">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Resolve by hand instead (advanced)
        </summary>
        <code className="block whitespace-pre-wrap font-mono text-xs">
          {conflictByHand(globId, branch, base)}
        </code>
      </details>
    </div>
  );
};

/** The conflict section: shown while a glob with an implementer has a merge conflict with its base. */
export const ConflictSection = ({ ctx: { glob } }: { ctx: GlobViewContext }) => {
  const conflict = glob.failure?.conflict ?? glob.conflict;
  if (conflict == null || glob.implementer === null) return null;
  return (
    <ConflictBox
      globId={glob.id}
      branch={glob.branch}
      base={conflict.base}
      canTakeOver={(glob.allowedActions ?? []).includes('take_over')}
    />
  );
};
