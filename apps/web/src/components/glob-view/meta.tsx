import type { GlobViewContext } from './context';

const when = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString());

/** Planner, implementer, creation date and pull requests. */
export const GlobMeta = ({
  ctx: { board, glob },
  decision,
}: {
  ctx: GlobViewContext;
  decision: boolean;
}) => {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <dt>Planner</dt>
      <dd>{glob.planner}</dd>
      <dt>Implementer</dt>
      <dd>{glob.implementer ?? '—'}</dd>
      <dt>Created</dt>
      <dd>{when(glob.createdAt)}</dd>
      {!decision && (
        <>
          <dt>Pull request</dt>
          <dd>
            {glob.pr === null ? (
              glob.provisioning === 'failed' ? (
                'provisioning failed; retrying'
              ) : glob.provisioning === 'none' ? (
                'opened when work starts'
              ) : glob.prs.length > 0 ? (
                'a new one opens on the next push'
              ) : (
                'opening…'
              )
            ) : board.repo === null ? (
              `#${glob.pr.number} (${glob.pr.state})`
            ) : (
              <a
                className="underline"
                href={`https://github.com/${board.repo}/pull/${glob.pr.number}`}
                target="_blank"
                rel="noreferrer"
              >
                #{glob.pr.number} ({glob.pr.state})
              </a>
            )}
          </dd>
        </>
      )}
      {glob.prs.length > 0 && (
        <>
          <dt>Merged and continued</dt>
          <dd className="flex flex-wrap gap-x-2">
            {glob.prs.map((p) => (
              <span key={p.number} title={`${p.mergeSha.slice(0, 7)} · ${when(p.mergedAt)}`}>
                {board.repo === null ? (
                  `#${p.number}`
                ) : (
                  <a
                    className="underline"
                    href={`https://github.com/${board.repo}/pull/${p.number}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    #{p.number}
                  </a>
                )}{' '}
                <span className="font-mono">{p.mergeSha.slice(0, 7)}</span>
              </span>
            ))}
          </dd>
        </>
      )}
    </dl>
  );
};

/** Every machine run on the glob, newest first. */
export const MachineRuns = ({ ctx: { glob } }: { ctx: GlobViewContext }) => {
  if (glob.runs.length === 0) return null;
  return (
    <div className="grid gap-1">
      <h3 className="text-xs font-semibold text-muted-foreground">Machine runs</h3>
      {[...glob.runs].reverse().map((run) => (
        <div key={run.id} className="flex justify-between gap-2 rounded bg-muted px-2 py-1 text-xs">
          <span>
            {run.purpose === 'investigate' && 'Investigation · '}
            {run.purpose === 'resolve_conflict' && 'Conflict fix · '}
            {run.state === 'ended' ? (run.outcome ?? 'ended') : run.state} · owner{' '}
            {run.routineOwner}
            {run.sessionUrl !== null && (
              <>
                {' · '}
                <a className="underline" href={run.sessionUrl} target="_blank" rel="noreferrer">
                  Open in Claude
                </a>
              </>
            )}
            {run.failureReason !== null && (
              <span className="block text-red">{run.failureReason}</span>
            )}
          </span>
          <span className="text-muted-foreground">
            queued {when(run.queuedAt)}
            {run.lastProgressAt !== null && ` · last progress ${when(run.lastProgressAt)}`}
          </span>
        </div>
      ))}
    </div>
  );
};
