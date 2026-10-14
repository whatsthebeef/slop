import type { GlobViewContext } from './context';

const when = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString());

/** The merged pull requests (the activity log carries the planner, the runs and the creation date); nothing when there are none. */
export const GlobMeta = ({ ctx: { board, glob } }: { ctx: GlobViewContext }) => {
  if (glob.prs.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
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
    </dl>
  );
};
