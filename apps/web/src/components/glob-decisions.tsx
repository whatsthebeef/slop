import type { DecisionRelation, DecisionView } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, RequestError } from '@/lib/api';
import { globDecisionsKey } from '@/lib/live';
import { cn } from '@/lib/utils';
import { useToast } from '@/toast';
import { Button } from './ui/button';

const day = (iso: string) => iso.slice(0, 10);

/** A citation back to where the choice was made: an in-app link (a glob or the Knowledge page) with the source's name. */
const Source = ({ label, url }: { label: string; url: string | null }) =>
  url === null ? <span>{label}</span> : <Link className='underline' to={url}>{label}</Link>;

/**
 * The glob view's choices: the choices taken on this glob (from its implementation record, plan.md, clarifications
 * and approved learnings), each with who decided, when and a link to its source. A choice a newer one replaced is
 * struck through and says by what and when; a replacement the model proposed but could not verify is shown as
 * proposed, with a link to the decision glob where an admin or PO confirms or dismisses it. Choice text comes from documents and models, so it is plain text.
 * `glob.decisions` hints and reconnects refresh it.
 */
export const GlobDecisions = ({ boardId, globId }: { boardId: number; globId: string }) => {
  const client = useQueryClient();
  const toast = useToast();
  const query = useQuery({ queryKey: globDecisionsKey(globId), queryFn: () => api.decisions(boardId, globId) });
  const change = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'confirm' | 'undo' }) =>
      action === 'confirm' ? api.confirmDecision(boardId, id) : api.undoDecision(boardId, id),
    onSuccess: () => void client.invalidateQueries({ queryKey: globDecisionsKey(globId) }),
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Could not save'),
  });
  // A choice a person may want decided on the board: it becomes a decision glob in Planning (the same one if asked again).
  const promote = useMutation({
    mutationFn: (id: number) => api.promoteDecision(boardId, id),
    onSuccess: ({ glob }) => {
      void client.invalidateQueries({ queryKey: ['globs', boardId] });
      toast(`Promoted to decision ${glob.id}`);
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Could not promote it'),
  });
  const decisions = query.data?.decisions ?? [];
  if (decisions.length === 0) return null;

  const buttons = (id: number, state: DecisionRelation['state']) => (
    <span className='inline-flex gap-1'>
      {state === 'hint' && (
        <Button size='sm' variant='outline' disabled={change.isPending} onClick={() => change.mutate({ id, action: 'confirm' })}>
          Confirm
        </Button>
      )}
      <Button size='sm' variant='outline' disabled={change.isPending} onClick={() => change.mutate({ id, action: 'undo' })}>
        {state === 'hint' ? 'Dismiss' : 'Undo'}
      </Button>
    </span>
  );

  const row = (d: DecisionView) => {
    const newer = d.replacedBy;
    const replaced = d.status === 'superseded';
    return (
      <li key={d.id} className='grid gap-0.5 text-xs' data-testid='decision'>
        <p className={cn('whitespace-pre-wrap break-words', replaced && 'text-muted-foreground line-through')}>{d.statement}</p>
        <div className='flex flex-wrap gap-x-2 text-[11px] text-muted-foreground'>
          {d.decidedBy !== null && <span>{d.decidedBy}</span>}
          <span>{day(d.decidedAt)}</span>
          <Source label={d.sourceLabel} url={d.sourceUrl} />
          {!replaced && d.sourceKind !== 'kb_item' && (
            <button type='button' className='underline' disabled={promote.isPending} onClick={() => promote.mutate(d.id)}>
              Promote to decision
            </button>
          )}
        </div>
        {newer?.state === 'hint' && (
          <p className='flex flex-wrap items-center gap-2 text-[11px]' data-testid='decision-proposed'>
            <span>
              Proposed: replaced by “{newer.statement}” ({day(newer.decidedAt)}){newer.reason === null || newer.reason === '' ? '' : ` — ${newer.reason}`}
            </span>
            {newer.cardGlobId == null ? (
              buttons(d.id, 'hint')
            ) : (
              <Link className='underline' to={`/boards/${String(boardId)}?glob=${encodeURIComponent(newer.cardGlobId)}`} data-testid='decision-card-link'>
                Decide on {newer.cardGlobId}
              </Link>
            )}
          </p>
        )}
        {replaced && newer !== null && (
          <p className='flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground' data-testid='decision-superseded'>
            <span>
              Replaced by “{newer.statement}” on {day(newer.decidedAt)}
            </span>
            {buttons(d.id, newer.state)}
          </p>
        )}
        {d.replaces.map((r) => (
            <p key={r.id} className='flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground'>
              <span>
                {r.state === 'hint' ? 'May replace' : 'Replaces'} “{r.statement}” ({day(r.decidedAt)})
              </span>
              {r.state === 'hint' && r.cardGlobId != null ? (
                <Link className='underline' to={`/boards/${String(boardId)}?glob=${encodeURIComponent(r.cardGlobId)}`}>
                  Decide on {r.cardGlobId}
                </Link>
              ) : (
                buttons(r.id, r.state)
              )}
            </p>
        ))}
      </li>
    );
  };

  return (
    <section className='grid gap-2' aria-label='Choices' data-testid='glob-decisions'>
      <h3 className='text-xs font-semibold text-muted-foreground'>Choices</h3>
      <ul className='grid gap-2'>{decisions.map(row)}</ul>
    </section>
  );
};
