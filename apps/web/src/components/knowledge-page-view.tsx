import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, RequestError } from '@/lib/api';
import type { KnowledgePageDecisionGroup } from '@/lib/api';
import { decisionLinks, decisionsHref, globHref, keyDecisions, recentAgentSetVersions, relativeTime } from '@/lib/knowledge-page';
import { useToast } from '@/toast';
import { Button } from './ui/button';

const linkClass = 'text-xs underline text-muted-foreground hover:text-foreground';

/**
 * The generated knowledge page: the agents and skills and the key decisions in force, as the board's
 * latest version (or an earlier one, read-only). Text comes from models and documents, so it is plain text. A server
 * without the endpoint hides the whole section.
 */
const DecisionList = ({ boardId, groups }: { boardId: number; groups: readonly KnowledgePageDecisionGroup[] }) => (
  <>
    {groups.map((g) => (
      <div key={g.area} className='grid gap-1'>
        <h4 className='text-xs font-semibold uppercase text-muted-foreground'>{g.area}</h4>
        <ul className='grid gap-1.5'>
          {(g.entries ?? []).map((entry) => (
            <li key={entry.text} className='grid gap-0.5 text-sm'>
              <span>{entry.text}</span>
              {entry.rationale !== undefined && entry.rationale !== '' && (
                <span className='text-xs text-muted-foreground'>{entry.rationale}</span>
              )}
              <span className='flex gap-2'>
                {decisionLinks(entry).map((l) => (
                  <Link key={l.id} className={linkClass} to={globHref(boardId, l.id)}>
                    {l.label}
                  </Link>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    ))}
  </>
);

/**
 * The recent agent-set versions the knowledge page observed, newest first, each with its date and changed files, for the
 * Agent set section. It shares the page's query; an older API (no history) or no versions yet shows nothing.
 */
export const AgentSetHistory = ({ boardId }: { boardId: number }) => {
  const page = useQuery({ queryKey: ['knowledge-page', boardId], queryFn: () => api.knowledgePage(boardId) });
  const versions = recentAgentSetVersions(page.data?.agentSetHistory);
  if (versions.length === 0) return null;
  return (
    <div className='grid gap-1' data-testid='agent-set-history'>
      <h3 className='text-sm font-medium'>Recent versions</h3>
      <ul className='grid gap-1.5'>
        {versions.map((v) => (
          <li key={v.version} className='grid gap-0.5 text-sm'>
            <span className='flex flex-wrap items-baseline gap-2'>
              <span>Version {v.version}</span>
              <span className='text-xs text-muted-foreground' title={v.at}>
                {v.at.slice(0, 10)}
              </span>
            </span>
            <span className='text-xs text-muted-foreground'>
              {(v.changedPaths ?? []).length > 0 ? `Changed: ${(v.changedPaths ?? []).join(', ')}` : 'No agent or skill file changed'}
            </span>
          </li>
        ))}
      </ul>
      <p className='text-xs text-muted-foreground'>
        Versions are noticed when the page regenerates, so several in one day show as one; hook, settings, MCP and CLAUDE.md
        changes list no files.
      </p>
    </div>
  );
};

export const KnowledgePageView = ({ boardId, admin }: { boardId: number; admin: boolean }) => {
  const client = useQueryClient();
  const toast = useToast();
  const [viewing, setViewing] = useState<number | null>(null);
  const [queued, setQueued] = useState(false);
  const page = useQuery({ queryKey: ['knowledge-page', boardId], queryFn: () => api.knowledgePage(boardId) });
  const earlier = useQuery({
    queryKey: ['knowledge-page', boardId, 'version', viewing],
    queryFn: () => api.knowledgePageVersion(boardId, viewing ?? 0),
    enabled: viewing !== null,
  });
  const rebuild = useMutation({
    mutationFn: () => api.rebuildKnowledgePage(boardId),
    onSuccess: () => {
      setQueued(true);
      toast('Rebuild queued');
      void client.invalidateQueries({ queryKey: ['knowledge-page', boardId] });
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Could not queue the rebuild'),
  });

  if (page.data === undefined || page.data === null) return null;
  const { current } = page.data;
  const history = page.data.history ?? [];
  const busy = rebuild.isPending || queued;
  const now = Date.now();
  const rebuildButton = admin && (
    <Button size='sm' variant='outline' disabled={busy} onClick={() => rebuild.mutate()} data-testid='knowledge-page-rebuild'>
      {busy ? 'Rebuild queued' : 'Rebuild'}
    </Button>
  );

  if (current === null) {
    return (
      <section className='grid gap-2' data-testid='knowledge-page'>
        <h2 className='text-sm font-semibold'>Knowledge page</h2>
        <p className='text-sm text-muted-foreground'>Not generated yet.</p>
        {rebuildButton}
      </section>
    );
  }

  const shown = viewing === null ? current : earlier.data;
  const sections = shown?.sections;
  const agents = sections?.agents ?? [];
  const decisions = keyDecisions(sections?.decisions ?? []);

  return (
    <section className='grid gap-4' data-testid='knowledge-page'>
      <div className='flex flex-wrap items-center gap-2'>
        <h2 className='text-sm font-semibold'>Knowledge page</h2>
        <span className='text-xs text-muted-foreground' title={current.createdAt}>
          Last regenerated {relativeTime(current.createdAt, now)}
        </span>
        <span className='ml-auto flex items-center gap-2'>
          {history.length > 1 && (
            <select
              aria-label='Version'
              className='h-7 rounded-md border bg-card px-2 text-xs'
              value={viewing ?? current.version}
              onChange={(e) => setViewing(Number(e.target.value) === current.version ? null : Number(e.target.value))}
            >
              {history.map((h) => (
                <option key={h.version} value={h.version}>
                  Version {h.version} · {h.createdAt.slice(0, 16).replace('T', ' ')}
                </option>
              ))}
            </select>
          )}
          {rebuildButton}
        </span>
      </div>

      {viewing !== null && (
        <div className='flex flex-wrap items-center gap-2 rounded-md border bg-muted p-2 text-xs' data-testid='knowledge-page-banner'>
          <span>
            Viewing version {viewing}
            {earlier.data === undefined ? '' : ` · ${earlier.data.createdAt.slice(0, 16).replace('T', ' ')}`}
          </span>
          <Button size='sm' variant='outline' className='ml-auto' onClick={() => setViewing(null)}>
            Back to current
          </Button>
        </div>
      )}

      {shown === undefined ? (
        <p className='text-sm text-muted-foreground'>{earlier.isError ? 'Could not load that version.' : 'Loading…'}</p>
      ) : (
        <>
          <div className='grid gap-1'>
            <h3 className='text-sm font-medium'>Agents and skills</h3>
            {agents.length === 0 && <p className='text-xs text-muted-foreground'>None.</p>}
            {agents.map((a) => (
              <div key={a.path} className='grid gap-0.5 rounded-md border bg-card p-2 text-sm'>
                <span className='flex flex-wrap items-center gap-2'>
                  <span className='font-medium'>{a.name}</span>
                  {a.changedInAgentSet != null && (
                    <span className='rounded bg-muted px-1.5 text-xs'>changed in agent set v{a.changedInAgentSet}</span>
                  )}
                  {a.decisionGlobId != null && (
                    <Link className={linkClass} to={globHref(boardId, a.decisionGlobId)}>
                      decision
                    </Link>
                  )}
                </span>
                {a.description !== undefined && a.description !== '' && (
                  <span className='text-xs text-muted-foreground'>{a.description}</span>
                )}
              </div>
            ))}
          </div>

          <div className='grid gap-2'>
            <h3 className='text-sm font-medium'>{decisions.flagged ? 'Key decisions' : 'Decisions in force'}</h3>
            {decisions.shown.length === 0 && <p className='text-xs text-muted-foreground'>None yet.</p>}
            <DecisionList boardId={boardId} groups={decisions.shown} />
            {decisions.moreCount > 0 && (
              <details className='grid gap-2' data-testid='knowledge-page-more'>
                <summary className='cursor-pointer text-xs text-muted-foreground'>
                  {decisions.moreCount} more decision{decisions.moreCount === 1 ? '' : 's'}
                </summary>
                <div className='mt-2 grid gap-2'>
                  <DecisionList boardId={boardId} groups={decisions.more} />
                </div>
              </details>
            )}
            <Link className={linkClass} to={decisionsHref(boardId)}>
              All decisions on the board
            </Link>
          </div>
        </>
      )}
    </section>
  );
};
