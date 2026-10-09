import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, RequestError } from '@/lib/api';
import type { GlobView, SplitPartInput } from '@/lib/api';
import { SplitGlob } from './split-glob';

/** Whether the glob carries an unanswered oversized flag that can still be answered (it hasn't started). */
export const isOversized = (glob: GlobView): boolean => glob.oversized === true && glob.status === 'planning';

/**
 * The size check's answer for a flagged glob: why it is flagged, the proposed split, and the three ways to answer it.
 * Split as proposed calls the split service with the proposal; Edit split opens its editor pre-filled; Keep whole records
 * the decision (it is read as an outcome when the glob merges) and starts a glob that was held for the flag.
 */
export const OversizedGlob = ({
  glob,
  canKeep,
  onDone,
}: {
  glob: GlobView;
  /** QA members can only decide subs, so Keep whole is hidden from them elsewhere. */
  canKeep: boolean;
  /** After a split or Keep whole: the caller refreshes the board. */
  onDone: () => void;
}) => {
  // The board list carries only the flag; the proposal comes with the single-glob read.
  const full = useQuery({ queryKey: ['size-check', glob.id], queryFn: () => api.glob(glob.id), enabled: glob.sizeCheck === undefined });
  const check = glob.sizeCheck ?? full.data?.sizeCheck;
  const [editing, setEditing] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingKeep, setConfirmingKeep] = useState(false);
  const proposal = check?.proposal ?? null;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onDone();
    } catch (e) {
      setError(e instanceof RequestError ? e.body.message : 'Could not do that');
    } finally {
      setBusy(false);
    }
  };
  const splitAsProposed = () =>
    act(() => {
      const parts: SplitPartInput[] = (proposal?.parts ?? []).map((p, index) => ({
        title: p.title,
        summary: p.summary,
        plan: p.plan,
        ...(index > 0 && p.after.length > 0 ? { after: [...p.after] } : {}),
      }));
      return api.splitGlob(glob.id, glob.version, parts, key);
    });
  if (editing) return <SplitGlob glob={glob} proposal={proposal ?? undefined} onCancel={() => setEditing(false)} onDone={onDone} />;
  return (
    <div className='grid gap-2 rounded border border-amber/60 bg-amber/10 p-3 text-xs' data-testid='oversized-proposal'>
      <p className='font-semibold'>Oversized: this looks like more than one PR's worth of work</p>
      {check !== undefined && (
        <p className='text-muted-foreground'>
          {check.reasons.join('; ')}. {glob.type === 'sub' || glob.waiting != null ? 'It stays in Planning until you answer.' : ''}
        </p>
      )}
      {check !== undefined && check.evidence.length > 0 && (
        <ul className='list-disc pl-4 text-muted-foreground'>
          {check.evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {proposal !== null && (
        <ol className='grid gap-1 pl-4' data-testid='oversized-parts'>
          {proposal.parts.map((p, index) => (
            <li key={index} className='list-decimal'>
              <span className='font-semibold'>{p.title}</span>
              {index === 0 ? ` (stays ${glob.id})` : ''}
              {p.after.length > 0 && <span className='text-muted-foreground'>, after {p.after.map((n) => `part ${n + 1}`).join(', ')}</span>}
              {p.summary !== '' && <span className='block text-muted-foreground'>{p.summary}</span>}
            </li>
          ))}
        </ol>
      )}
      {check === undefined ? (
        <p className='text-muted-foreground'>{full.isError ? 'Could not load the proposed split.' : 'Loading the proposed split…'}</p>
      ) : (
        proposal === null && <p className='text-muted-foreground'>No split could be proposed; cut it yourself with Edit split.</p>
      )}
      <div className='flex flex-wrap items-center gap-2'>
        {proposal !== null && (
          <Button size='sm' disabled={busy} data-testid='split-as-proposed' onClick={() => void splitAsProposed()}>
            Split as proposed
          </Button>
        )}
        <Button size='sm' variant='outline' disabled={busy} data-testid='edit-split' onClick={() => setEditing(true)}>
          Edit split
        </Button>
        {canKeep && (
          <Button size='sm' variant='outline' disabled={busy} data-testid='keep-whole' onClick={() => setConfirmingKeep(true)}>
            Keep whole
          </Button>
        )}
      </div>
      {confirmingKeep && (
        <div role='alert' className='flex flex-wrap items-center gap-2'>
          <span className='flex-1'>Keep it as one glob? slop learns from how it goes.</span>
          <Button size='sm' variant='ghost' onClick={() => setConfirmingKeep(false)}>
            Cancel
          </Button>
          <Button size='sm' disabled={busy} data-testid='confirm-keep-whole' onClick={() => void act(() => api.keepWhole(glob.id))}>
            Keep whole
          </Button>
        </div>
      )}
      {error !== null && (
        <p role='alert' className='text-red' data-testid='oversized-failure'>
          {error}
        </p>
      )}
    </div>
  );
};
