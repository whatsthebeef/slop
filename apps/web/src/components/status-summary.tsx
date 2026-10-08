import type { GlobView } from '@/lib/api';
import { statusLine } from '@/lib/status-line';
import { cn } from '@/lib/utils';

const link = (href: string, text: string) => (
  <a className='underline underline-offset-2' href={href} target='_blank' rel='noreferrer'>
    {text}
  </a>
);

/** The glob view's single status line: the card's line in full, with the failing run's log and what is being done. */
export const StatusSummary = ({ glob }: { glob: GlobView }) => {
  const status = statusLine(glob, new Date().toISOString());
  if (status === null) return null;
  const { doing } = status;
  return (
    <p className={cn('rounded border p-2 text-sm', status.tone, status.tone === 'text-red' && 'border-red/40 bg-red/10')} data-testid='glob-status-line' data-kind={status.kind}>
      {status.full}
      {status.url !== null && <> ({link(status.url, 'log')})</>}
      {doing !== null && (
        <>
          {' — '}
          {doing.url === null ? doing.text : link(doing.url, doing.text)}
        </>
      )}
    </p>
  );
};
