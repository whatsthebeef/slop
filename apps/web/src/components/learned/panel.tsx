import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * One topic of "What slop has learned": collapsed by default, its one-line blurb always visible. The body (value, default,
 * actions, history) is rendered, and so fetched, only while the panel is open.
 */
export const LearnedPanel = ({
  id,
  title,
  blurb,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  blurb: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) => (
  <section id={`learned-${id}`} data-testid={`learned-${id}`} className='grid scroll-mt-4 gap-2 rounded-md border bg-card p-3'>
    <h3 className='text-sm font-medium'>
      <button
        type='button'
        className='flex w-full items-center gap-1 text-left'
        aria-expanded={open}
        aria-controls={`learned-${id}-body`}
        data-testid={`learned-${id}-toggle`}
        onClick={onToggle}
      >
        {open ? <ChevronDown aria-hidden className='size-4' /> : <ChevronRight aria-hidden className='size-4' />}
        {title}
      </button>
    </h3>
    <p className='text-xs text-muted-foreground'>{blurb}</p>
    {open && (
      <div id={`learned-${id}-body`} className='grid gap-3'>
        {children}
      </div>
    )}
  </section>
);

/** A sub-heading inside a panel that holds more than one learned value (Size, Intake). */
export const PanelPart = ({ title, testId, children }: { title: string; testId: string; children: ReactNode }) => (
  <div className='grid gap-2' data-testid={testId}>
    <h4 className='text-xs font-semibold'>{title}</h4>
    {children}
  </div>
);

/** The current value in plain words. */
export const Value = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p className='text-sm' data-testid={testId}>
    {children}
  </p>
);

/** What the value started from. */
export const DefaultLine = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p className='text-xs text-muted-foreground' data-testid={testId}>
    {children}
  </p>
);

/** How it works, in a few sentences. */
export const Explainer = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p className='text-xs text-muted-foreground' data-testid={testId}>
    {children}
  </p>
);

/** History of changes, newest first, collapsed until asked for. With none recorded it says so instead. */
export const History = ({
  testId,
  count,
  empty,
  noun = ['change', 'changes'],
  children,
}: {
  testId: string;
  count: number;
  empty: string;
  noun?: readonly [string, string];
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  if (count === 0)
    return (
      <p className='text-xs text-muted-foreground' data-testid={testId}>
        {empty}
      </p>
    );
  return (
    <div className='grid gap-1' data-testid={testId}>
      <h4 className='text-xs font-semibold text-muted-foreground'>
        <button type='button' className='flex items-center gap-1' aria-expanded={open} onClick={() => setOpen(!open)} data-testid={`${testId}-toggle`}>
          {open ? <ChevronDown aria-hidden className='size-3.5' /> : <ChevronRight aria-hidden className='size-3.5' />}
          History: {count} {count === 1 ? noun[0] : noun[1]}, newest first
        </button>
      </h4>
      {open && children}
    </div>
  );
};

/** What a panel shows when its data could not be loaded. */
export const LoadFailed = ({ what, onRetry }: { what: string; onRetry: () => void }) => (
  <p className='flex items-center gap-2 text-sm text-red'>
    Could not load {what}.
    <Button size='sm' variant='outline' onClick={onRetry}>
      Retry
    </Button>
  </p>
);

export const LoadingText = ({ what }: { what: string }) => <p className='text-sm text-muted-foreground'>Loading {what}…</p>;

/** An admin action with a message when it failed. Members don't get it. */
export const ResetButton = ({
  admin,
  show = true,
  pending,
  failed,
  label = 'Reset to defaults',
  failure,
  onClick,
}: {
  admin: boolean;
  show?: boolean;
  pending: boolean;
  failed: boolean;
  label?: string;
  failure: string;
  onClick: () => void;
}) =>
  admin && show ? (
    <div>
      <Button size='sm' variant='outline' disabled={pending} onClick={onClick}>
        {label}
      </Button>
      {failed && <span className='ml-2 text-xs text-red'>{failure}</span>}
    </div>
  ) : null;
