import type { BoardNotification } from '@slop/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, dismissedNotificationsKey, healthKey, notificationsKey } from '@/lib/api';
import { signInPoll, signInView } from '@/lib/aws-sign-in';
import type { SignInView } from '@/lib/aws-sign-in';
import { barView, canDismiss, dismissedLabel, linkTarget, pollInterval, shownRows, toggleLabel } from '@/lib/notification-bar';
import { cn } from '@/lib/utils';

const OUTLINE: Record<BoardNotification['severity'], string> = { critical: 'border-red', warning: 'border-amber', info: 'border-edge' };

const STYLE: Record<BoardNotification['severity'], string> = {
  critical: 'bg-red/15 py-3 text-base font-semibold',
  warning: 'bg-amber/15 py-2 text-sm',
  info: 'bg-card py-2 text-sm text-muted-foreground',
};

/** The AWS sign-in on the bar: the button, then the link and code to approve, or why it failed. */
export const SignInAction = ({ view, pending, onStart }: { view: SignInView; pending: boolean; onStart: () => void }) => {
  const button = (
    <Button size='sm' disabled={pending} onClick={onStart}>
      Sign in to AWS
    </Button>
  );
  switch (view.kind) {
    case 'button':
      return button;
    case 'ask-admin':
      return <span className='text-sm font-normal'>Ask a board admin to sign in to AWS.</span>;
    case 'waiting':
      return (
        <span className='text-sm font-normal' data-testid='aws-sign-in-code'>
          Open{' '}
          <a className='underline' href={view.verificationUri} target='_blank' rel='noreferrer'>
            the AWS sign-in page
          </a>{' '}
          and confirm the code <strong className='font-mono'>{view.userCode}</strong>.
        </span>
      );
    case 'failed':
      return (
        <>
          <span className='text-sm font-normal'>{view.message}. Try again.</span>
          {view.canRetry && button}
        </>
      );
  }
};

/** Runs the server's device sign-in; the bar clears by itself once Bedrock answers again. */
const AwsSignInAction = () => {
  const client = useQueryClient();
  const health = useQuery({ queryKey: healthKey, queryFn: api.health, refetchInterval: (query) => signInPoll(query.state.data?.awsSignIn) });
  const start = useMutation({ mutationFn: api.startAwsSignIn, onSuccess: () => client.invalidateQueries({ queryKey: healthKey }) });
  const view = signInView(health.data?.awsSignIn ?? null);
  return view === null ? null : <SignInAction view={view} pending={start.isPending} onStart={() => start.mutate()} />;
};

const Row = ({ item, boardId, flash }: { item: BoardNotification; boardId: number; flash: boolean }) => {
  const client = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => api.dismissNotification(boardId, item.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['notifications', boardId] }),
  });
  const action = item.action;
  return (
    <div
      role={item.severity === 'critical' ? 'alert' : 'status'}
      className={cn('flex items-center gap-x-3 gap-y-1 px-4 not-first:border-t not-first:border-edge', item.source !== 'main-red' && 'flex-wrap', STYLE[item.severity], flash && 'notification-flash')}
      data-testid={`notification-${item.source}`}
      data-severity={item.severity}
    >
      <span className={cn(item.source === 'main-red' ? 'min-w-0 flex-1 truncate whitespace-nowrap text-left' : undefined)} title={item.source === 'main-red' ? `${item.title}\n${item.detail}` : undefined}>
        {item.title}
      </span>
      {item.source !== 'main-red' && <span className={cn('font-normal', item.severity === 'critical' && 'text-sm')}>{item.detail}</span>}
      {action?.kind === 'aws-sign-in' && <AwsSignInAction />}
      {action !== null && action.kind !== 'aws-sign-in' && (
        <a className='shrink-0 text-sm font-normal underline' href={action.href} {...linkTarget(action.href)} rel='noreferrer'>
          {action.label}
        </a>
      )}
      {canDismiss(item) && (
        <button type='button' className='ml-auto shrink-0 text-sm font-normal underline' disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
          Dismiss
        </button>
      )}
    </div>
  );
};

/**
 * One bar across the top of every board page for board-wide incidents that need a person. The most severe shows in
 * full (critical is big and red, flashes once on arrival; every notification can be dismissed per person); the
 * others sit behind "more… (N)" just below it, which grows them into one attached stack with "Show less" in the same place below. It sits above the tabs.
 */
export const NotificationBar = ({ boardId }: { boardId: number }) => {
  const [expanded, setExpanded] = useState(false);
  const items = useQuery({
    queryKey: notificationsKey(boardId),
    queryFn: () => api.notifications(boardId),
    // A hint refetches at once; the poll is the backstop.
    refetchInterval: (query) => pollInterval((query.state.data?.length ?? 0) > 0),
  });
  const dismissed = useQuery({ queryKey: dismissedNotificationsKey(boardId), queryFn: () => api.dismissedNotifications(boardId) });
  const client = useQueryClient();
  const restore = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.restoreNotification(boardId, id);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['notifications', boardId] }),
  });
  const hidden = dismissed.data ?? [];
  const view = barView(items.data ?? []);
  const undo =
    hidden.length === 0 ? null : (
      <button
        type='button'
        className='mt-1 block text-sm font-normal text-muted-foreground underline'
        data-testid='notifications-dismissed'
        title={hidden.map((n) => n.title).join('\n')}
        disabled={restore.isPending}
        onClick={() => restore.mutate(hidden.map((n) => n.id))}
      >
        {dismissedLabel(hidden.length)}
      </button>
    );
  if (view === null) return undo === null ? null : <div className='mx-5'>{undo}</div>;
  return (
    <div className='mx-5' data-testid='notification-bar'>
      {/* One stack: the rows share the outer border and are split by hairlines. Keyed by id so a new arrival flashes once. */}
      <div className={cn('overflow-hidden rounded-md border', OUTLINE[view.lead.severity])}>
        {shownRows(view, expanded).map((item, i) => (
          <Row
            key={item.id}
            item={item}
            boardId={boardId}
            flash={i === 0 && item.severity === 'critical'}
          />
        ))}
      </div>
      {/* Below the stack: "more… (N)" under the lead, which becomes "Show less" in the same place under the last row. */}
      {view.rest.length > 0 && (
        <div className='mt-1'>
          <button type='button' className='text-sm font-normal text-muted-foreground underline' aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {toggleLabel(expanded, view.rest.length)}
          </button>
        </div>
      )}
      {undo}
    </div>
  );
};
