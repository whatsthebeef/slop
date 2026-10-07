import { failureSummary, MANUAL_READINESS_KEYS } from '@slop/core';
import type { ManualReadinessKey, ReadinessItem } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, RequestError } from '@/lib/api';
import type { BoardView } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useToast } from '@/toast';

const manualKey = (key: ReadinessItem['key']): ManualReadinessKey | null => MANUAL_READINESS_KEYS.find((k) => k === key) ?? null;

export const readinessKey = (boardId: number) => ['readiness', boardId] as const;

const MARK: Record<ReadinessItem['state'], { text: string; className: string }> = {
  ok: { text: 'OK', className: 'border-foreground bg-lcd text-lcd-foreground' },
  missing: { text: 'TODO', className: 'border-required-border text-required' },
  failing: { text: 'FAILING', className: 'border-red text-red' },
  unknown: { text: '?', className: 'border-edge text-muted-foreground' },
};

const FixLink = ({ item, boardId }: { item: ReadinessItem; boardId: number }) => {
  const fix = item.fix;
  if (fix === null) return null;
  const className = 'text-xs underline';
  if (fix.kind === 'link') {
    return (
      <a className={className} href={fix.href} target={fix.href.startsWith('/') ? undefined : '_blank'} rel='noreferrer'>
        {fix.label}
      </a>
    );
  }
  return (
    <Link className={className} to={`/boards/${String(boardId)}/${fix.kind}`}>
      {fix.label}
    </Link>
  );
};

/**
 * The board's readiness checklist in settings: each item's state, why, and a Fix link. Admins tick
 * the items slop can't check; a matching routine failure turns a ticked item red.
 */
export const ReadinessChecklist = ({ board }: { board: BoardView }) => {
  const client = useQueryClient();
  const toast = useToast();
  const items = useQuery({ queryKey: readinessKey(board.id), queryFn: () => api.readiness(board.id) });
  const admin = board.role === 'admin';
  const tick = useMutation({
    mutationFn: ({ key, value }: { key: ManualReadinessKey; value: boolean }) =>
      api.updateSettings(board.id, board.version, { readinessTicks: { ...board.readinessTicks, [key]: value } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['board', board.id] });
      void client.invalidateQueries({ queryKey: readinessKey(board.id) });
    },
    onError: (e) => toast(e instanceof RequestError ? e.body.message : 'Could not save'),
  });

  return (
    <section className='grid gap-2' id='readiness' data-testid='readiness'>
      <h2 className='text-sm font-semibold'>Readiness</h2>
      {items.data === undefined ? (
        <p className='text-sm text-muted-foreground'>Checking…</p>
      ) : (
        <ul className='grid gap-1.5'>
          {items.data.map((item) => (
            <li key={item.key} className='grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-start gap-3 text-sm'>
              <span className={cn('rounded-sm border px-1.5 text-center font-mono text-[10px] font-semibold', MARK[item.state].className)}>
                {MARK[item.state].text}
              </span>
              <span className='grid'>
                <span className='font-medium'>{item.title}</span>
                <span className='text-xs text-muted-foreground'>{item.detail}</span>
              </span>
              <span className='flex items-center gap-3'>
                {(() => {
                  const key = manualKey(item.key);
                  return key === null ? null : (
                    <label className='flex items-center gap-1 text-xs'>
                      <input
                        type='checkbox'
                        disabled={!admin || tick.isPending}
                        checked={board.readinessTicks[key] === true}
                        onChange={(e) => tick.mutate({ key, value: e.target.checked })}
                      />
                      done
                    </label>
                  );
                })()}
                {item.state !== 'ok' && <FixLink item={item} boardId={board.id} />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** A banner on the board while any readiness item needs doing (unknown items don't count). */
export const ReadinessBanner = ({ boardId }: { boardId: number }) => {
  const items = useQuery({ queryKey: readinessKey(boardId), queryFn: () => api.readiness(boardId), staleTime: 60_000 });
  const open = (items.data ?? []).filter((i) => i.state === 'missing' || i.state === 'failing');
  if (open.length === 0) return null;
  const failing = open.some((i) => i.state === 'failing');
  return (
    <div
      role='status'
      className={cn(
        'mx-5 mt-3 flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
        failing ? 'border-red/60 bg-red/10' : 'border-required-border bg-card',
      )}
      data-testid='readiness-banner'
    >
      <span>
        Board setup: {open.length} {open.length === 1 ? 'item needs' : 'items need'} doing ({open.map((i) => i.title).join(', ')}).
      </span>
      <Link className='underline' to={`/boards/${String(boardId)}/settings#readiness`}>
        Readiness checklist
      </Link>
    </div>
  );
};

/** A banner on the board while its base branch's checks fail, naming the glob whose merge turned it red. */
export const BaseRedBanner = ({ board }: { board: BoardView }) => {
  const checks = board.baseChecks;
  if (checks == null || checks.state !== 'failed') return null;
  const failure = checks.failure;
  return (
    <div
      role='status'
      className='mx-5 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-red/60 bg-red/10 px-3 py-1.5 text-sm'
      data-testid='base-red-banner'
    >
      <span>
        {board.baseBranch} is red{checks.since === null ? '' : ` since ${checks.since} merged`}
        {failure === undefined ? '' : `: ${failureSummary(failure)}`}. Globs failing the same way are waiting for it; don't fix it in their branches.
      </span>
      {failure?.url != null && (
        <a className='underline' href={failure.url} target='_blank' rel='noreferrer'>
          Open the run
        </a>
      )}
    </div>
  );
};
