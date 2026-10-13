import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Input, Label } from '@/components/ui/input';
import { blockedLine, dependencySummary, statusWords } from '@/lib/status-line';
import type { GlobViewContext } from './context';

const GlobLink = ({ boardId, id }: { boardId: number; id: string }) => (
  <Link
    to={`/boards/${String(boardId)}?glob=${encodeURIComponent(id)}`}
    className="font-mono underline"
  >
    {id}
  </Link>
);

/** What the glob waits for, overlaps with and is waited on by; the "waits for" list is editable until it has a branch. */
export const DependenciesSection = ({
  ctx: { glob },
  onEditAfter,
}: {
  ctx: GlobViewContext;
  /** The edited "waits for" glob IDs (goes into the view's draft). */
  onEditAfter: (after: string[]) => void;
}) => {
  // The globs it waits for can change until it has a branch.
  const canEditAfter =
    glob.status === 'planning' && glob.provisioning === 'none' && glob.type !== 'super';
  const [afterText, setAfterText] = useState((glob.after ?? []).join(', '));
  const [showChain, setShowChain] = useState(false);
  useEffect(() => setAfterText((glob.after ?? []).join(', ')), [glob.id, glob.after]);
  const summary = dependencySummary(glob);
  const deps =
    summary !== null || canEditAfter
      ? (summary ?? { needs: [], alsoAhead: [], overlaps: [], waitedOnBy: [] })
      : null;
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
      {canEditAfter && (
        <Label>
          Waits for (glob IDs)
          <Input
            value={afterText}
            placeholder="s15t7, s15b18"
            onChange={(e) => {
              setAfterText(e.target.value);
              onEditAfter(e.target.value.split(/[\s,]+/).filter((id) => id !== ''));
            }}
          />
        </Label>
      )}
      {(glob.blockedBy?.length ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          Picking it up goes ahead without them: the branch will lack their changes.
        </p>
      )}
    </div>
  );
};
