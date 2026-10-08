import type { BoardNotification } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, notificationsKey } from '@/lib/api';
import { barView, canDismiss, moreLabel, pollInterval } from '@/lib/notification-bar';
import { cn } from '@/lib/utils';

const STYLE: Record<BoardNotification['severity'], string> = {
  critical: 'border-red bg-red/15 py-3 text-base font-semibold',
  warning: 'border-amber bg-amber/15 py-1.5 text-sm',
  info: 'border-edge bg-card py-1 text-xs text-muted-foreground',
};

const Row = ({ item, boardId, flash }: { item: BoardNotification; boardId: number; flash: boolean }) => {
  const client = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => api.dismissNotification(boardId, item.id),
    onSuccess: () => client.invalidateQueries({ queryKey: notificationsKey(boardId) }),
  });
  const action = item.action;
  return (
    <div
      role={item.severity === 'critical' ? 'alert' : 'status'}
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-5', STYLE[item.severity], flash && 'notification-flash')}
      data-testid={`notification-${item.source}`}
      data-severity={item.severity}
    >
      <span>{item.title}</span>
      <span className={cn('font-normal', item.severity === 'critical' && 'text-sm')}>{item.detail}</span>
      {action !== null && (
        <a className='text-sm font-normal underline' href={action.href} target={action.href.startsWith('/') ? undefined : '_blank'} rel='noreferrer'>
          {action.label}
        </a>
      )}
      {canDismiss(item) && (
        <button type='button' className='ml-auto text-sm font-normal underline' disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
          Dismiss
        </button>
      )}
    </div>
  );
};

/**
 * One bar across the top of every board page for board-wide incidents that need a person. The most severe shows in
 * full (critical is big and red, flashes once on arrival and can't be dismissed while its condition holds); the
 * others show as a count that expands.
 */
export const NotificationBar = ({ boardId }: { boardId: number }) => {
  const [expanded, setExpanded] = useState(false);
  const items = useQuery({
    queryKey: notificationsKey(boardId),
    queryFn: () => api.notifications(boardId),
    // A hint refetches at once; the poll is the backstop.
    refetchInterval: (query) => pollInterval((query.state.data?.length ?? 0) > 0),
  });
  const view = barView(items.data ?? []);
  if (view === null) return null;
  return (
    <div data-testid='notification-bar'>
      {/* Keyed by id so a new arrival mounts afresh and flashes once. */}
      <Row key={view.lead.id} item={view.lead} boardId={boardId} flash={view.lead.severity === 'critical'} />
      {view.rest.length > 0 && (
        <div className='border-b border-edge bg-card px-5 py-1 text-xs'>
          <button type='button' className='underline' aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {moreLabel(view.rest.length)}
          </button>
        </div>
      )}
      {expanded && view.rest.map((item) => <Row key={item.id} item={item} boardId={boardId} flash={false} />)}
    </div>
  );
};
