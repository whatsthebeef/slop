import { useState } from 'react';
import { Link } from 'react-router';
import { blockedLine, dependencySummary, isDismissible, statusWords } from '@/lib/status-line';
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
const DismissEdge = ({ id, onDismiss }: { id: string; onDismiss: (edgeId: string) => Promise<boolean> }) => (
  <button
    type="button"
    className="ml-2 text-xs text-muted-foreground hover:text-foreground"
    title="Not a dependency"
    aria-label="Not a dependency"
    data-testid={`dismiss-edge-${id}`}
    onClick={() => void onDismiss(id)}
  >
    ✕
  </button>
);

/** What the glob waits for, overlaps with and is waited on by. Slop infers the edges; a person can only dismiss a wrong one. */
export const DependenciesSection = ({
  ctx: { glob },
  onDismissEdge,
}: {
  ctx: GlobViewContext;
  /** The ✕ on a needs or overlaps row: the edge to this glob is not a dependency; resolves false when it failed. */
  onDismissEdge: (edgeId: string) => Promise<boolean>;
}) => {
  const [showChain, setShowChain] = useState(false);
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
              <li key={n.id}>
                <GlobLink boardId={glob.boardId} id={n.id} />
                {n.status !== null && (
                  <span className="text-muted-foreground"> · {n.status}</span>
                )}{' '}
                <span className="text-muted-foreground">{n.why}</span>
                {n.dismissible && <DismissEdge id={n.id} onDismiss={onDismissEdge} />}
              </li>
            ))}
          </ul>
        </div>
      )}
      {deps.alsoAhead.length > 0 && (
        <div data-testid="also-ahead">
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            aria-expanded={showChain}
            onClick={() => setShowChain(!showChain)}
          >
            {showChain ? '▾' : '▸'} {deps.alsoAhead.length} more ahead
          </button>
          {showChain && (
            <ul className="ml-4 list-disc">
              {deps.alsoAhead.map((b) => (
                <li key={b.id} style={{ marginLeft: `${String((b.depth - 2) * 12)}px` }}>
                  <GlobLink boardId={glob.boardId} id={b.id} />{' '}
                  <span className="text-muted-foreground">· {statusWords(b.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {deps.overlaps.length > 0 && (
        <div data-testid="overlaps">
          <span className="font-medium">Overlaps</span>{' '}
          <span className="text-xs text-muted-foreground">merge order only; never blocks</span>
          <ul className="ml-4 list-disc">
            {deps.overlaps.map((o) => (
              <li key={o.id}>
                <GlobLink boardId={glob.boardId} id={o.id} />
                {o.paths.length > 0 && (
                  <span className="text-muted-foreground"> · {o.paths.join(', ')}</span>
                )}
                {o.evidence !== undefined && (
                  <span className="text-muted-foreground"> · {o.evidence}</span>
                )}
                {isDismissible(o) && <DismissEdge id={o.id} onDismiss={onDismissEdge} />}
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
      {(glob.blockedBy?.length ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          Picking it up goes ahead without them: the branch will lack their changes.
        </p>
      )}
    </div>
  );
};
