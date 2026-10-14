import { Link } from 'react-router';
import { blockedLine, dependencySummary } from '@/lib/status-line';
import type { GlobViewContext } from './context';

const GlobLink = ({ boardId, id }: { boardId: number; id: string }) => (
  <Link
    to={`/boards/${String(boardId)}?glob=${encodeURIComponent(id)}`}
    className="font-mono underline"
  >
    {id}
  </Link>
);

/** The small ✕ on a recorded dependency row: slop got it wrong, it is not a dependency. */
const DismissEdge = ({ id, relationId, onDismiss }: { id: string; relationId: string; onDismiss: (relationId: string) => Promise<boolean> }) => (
  <button
    type="button"
    className="ml-2 text-xs text-muted-foreground hover:text-foreground"
    title="Not a dependency"
    aria-label="Not a dependency"
    data-testid={`dismiss-edge-${id}`}
    onClick={() => void onDismiss(relationId)}
  >
    ✕
  </button>
);

/** What the glob waits for and is waited on by. Slop infers the relations; a person can dismiss a wrong one. */
export const DependenciesSection = ({
  ctx: { glob },
  onDismissEdge,
}: {
  ctx: GlobViewContext;
  /** The ✕ on a row: the relation is not a dependency; resolves false when it failed. */
  onDismissEdge: (relationId: string) => Promise<boolean>;
}) => {
  const deps = dependencySummary(glob);
  if (deps === null) return null;
  return (
    <div className="grid gap-2 rounded border p-2 text-sm" data-testid="dependencies">
      <span className="font-medium">Dependencies</span>
      {blockedLine(glob) !== null && (
        <span className="text-xs text-muted-foreground">{blockedLine(glob)}</span>
      )}
      {deps.needs.length > 0 && (
        <div data-testid="waits-for">
          <span className="font-medium">Waits for</span>
          <ul className="ml-4 list-disc">
            {deps.needs.map((n) => (
              <li key={n.relationId}>
                <GlobLink boardId={glob.boardId} id={n.id} />
                {n.status !== null && (
                  <span className="text-muted-foreground"> · {n.status}</span>
                )}{' '}
                <span className="text-muted-foreground">{n.why}</span>
                {n.dismissible && <DismissEdge id={n.id} relationId={n.relationId} onDismiss={onDismissEdge} />}
              </li>
            ))}
          </ul>
        </div>
      )}
      {deps.waitedOnBy.length > 0 && (
        <div data-testid="waited-on-by">
          <span className="font-medium">Waited on by</span>{' '}
          {deps.waitedOnBy.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <GlobLink boardId={glob.boardId} id={id} />
            </span>
          ))}
        </div>
      )}
      {blockedLine(glob) !== null && (
        <p className="text-xs text-muted-foreground">
          Picking it up goes ahead without them: the branch will lack their changes.
        </p>
      )}
    </div>
  );
};
