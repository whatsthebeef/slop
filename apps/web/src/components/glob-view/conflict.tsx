import { conflictByHand, conflictCommand } from '@/lib/sstor-command';
import { Block, blockActor } from './block';
import type { GlobViewContext } from './context';

/** The by-hand route to resolve a conflict, collapsed. */
const ByHand = ({ globId, branch, base }: { globId: string; branch: string; base: string }) => (
  <details data-testid="conflict-by-hand">
    <summary className="cursor-pointer text-xs text-muted-foreground">Resolve by hand instead (advanced)</summary>
    <code className="block whitespace-pre-wrap font-mono text-xs">{conflictByHand(globId, branch, base)}</code>
  </details>
);

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

/** "Since s1t9 merged, both sides changed 2 files." The cause and the count, from the facts. */
const conflictWhy = (since: string | null | undefined, files: number): string => {
  const what = files === 0 ? 'some of the same files' : `${String(files)} ${files === 1 ? 'file' : 'files'}`;
  return since == null ? `Both sides changed ${what}.` : `Since ${since} merged, both sides changed ${what}.`;
};

/**
 * The conflict section, one problem block: a conflict with the base branch (its cause and every file, and for a glob with an
 * implementer the command to resolve it) and a clash with another glob. The card only says it in a few words, so the detail is here.
 */
export const ConflictSection = ({ ctx: { glob } }: { ctx: GlobViewContext }) => {
  const open = glob.conflict ?? null;
  const conflict = glob.failure?.conflict ?? open;
  const clash = glob.clash ?? null;
  if (conflict == null && clash === null) return null;
  const resolvable = conflict != null && glob.implementer !== null;
  const canTakeOver = (glob.allowedActions ?? []).includes('take_over');
  return (
    <Block
      tone="problem"
      actor={blockActor(glob)}
      testId="conflict-block"
      title={conflict != null ? `Conflicts with ${conflict.base}` : `Clashes with ${clash?.with ?? ''}`}
      why={conflict != null && <span data-testid="conflict-facts">{conflictWhy(open?.since, conflict.files.length)}</span>}
      {...(resolvable
        ? {
            fix: {
              text: `${canTakeOver ? 'Pick up and let your Claude session' : 'Let your Claude session'} merge ${conflict.base}: it resolves additive conflicts and asks you about the rest.`,
              command: conflictCommand(glob.id, canTakeOver),
              commandTestId: 'conflict-command',
            },
          }
        : {})}
      more={resolvable && <ByHand globId={glob.id} branch={glob.branch} base={conflict.base} />}
    >
      {conflict != null && conflict.files.length > 0 && <ConflictFiles files={conflict.files} />}
      {clash !== null && (
        <div className="grid gap-1" data-testid="conflict-clash">
          <span>{clash.with} also changes some of the same files; whichever merges second will conflict.</span>
          {clash.paths.length > 0 && (
            <ul className="list-disc pl-5 font-mono text-xs">
              {clash.paths.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Block>
  );
};
