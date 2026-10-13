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

/** Every conflicting file; opened up to ten, then collapsed under its count. */
const ConflictFiles = ({ files }: { files: readonly string[] }) => (
  <details data-testid="conflict-files" open={files.length <= 10}>
    <summary className="cursor-pointer text-xs text-muted-foreground">
      Files changed on both sides ({files.length})
    </summary>
    <ul className="font-mono text-xs break-all">
      {files.map((f) => (
        <li key={f}>{f}</li>
      ))}
    </ul>
  </details>
);

/**
 * The conflict section: a conflict with the base branch (its cause and every file, and for a glob with an implementer the
 * command to resolve it) and a clash with another glob. The card only says it in a few words, so the detail is here.
 */
export const ConflictSection = ({ ctx: { glob } }: { ctx: GlobViewContext }) => {
  const open = glob.conflict ?? null;
  const conflict = glob.failure?.conflict ?? open;
  const clash = glob.clash ?? null;
  if (conflict == null && clash === null) return null;
  return (
    <div className="grid gap-2">
      {conflict != null && (
        <div className="grid gap-1 text-sm" data-testid="conflict-facts">
          <span>
            This PR conflicts with {conflict.base}
            {open?.since == null ? '' : `, since ${open.since} merged`}.
          </span>
          {conflict.files.length > 0 && <ConflictFiles files={conflict.files} />}
        </div>
      )}
      {clash !== null && (
        <div className="grid gap-1 text-sm" data-testid="conflict-clash">
          <span>
            {clash.with} also changes some of the same files; whichever merges second will conflict.
          </span>
          {clash.paths.length > 0 && (
            <ul className="list-disc pl-5 font-mono text-xs">
              {clash.paths.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {conflict != null && glob.implementer !== null && (
        <ConflictBox
          globId={glob.id}
          branch={glob.branch}
          base={conflict.base}
          canTakeOver={(glob.allowedActions ?? []).includes('take_over')}
        />
      )}
    </div>
  );
};
