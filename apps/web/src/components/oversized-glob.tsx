import { useQuery } from '@tanstack/react-query';
import type { SizeForecast } from '@slop/core';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, RequestError } from '@/lib/api';
import type { GlobView, SplitPartInput } from '@/lib/api';
import { SplitGlob } from './split-glob';

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** The size forecast (spec, Intake): the predicted footprint, its parts, the similar past globs and the calibration applied. */
export const SizeForecastView = ({ forecast }: { forecast: SizeForecast }) => (
  <div className='grid gap-1 rounded border border-border p-2' data-testid='size-forecast'>
    <p className='font-semibold'>
      Forecast ({forecast.source === 'code' ? 'from the code' : 'from the plan text'}): about {forecast.files.count} files in {forecast.modules.length} modules,{' '}
      {forecast.lines.min} to {forecast.lines.max} lines
    </p>
    <p className='text-muted-foreground'>
      Risk {forecast.riskTier}
      {forecast.riskAreas.length > 0 ? ` (${forecast.riskAreas.join(', ')})` : ''}; confidence {forecast.confidence}
      {forecast.migration ? '; touches a migration' : ''}
      {forecast.publicApi ? '; touches a public API' : ''}
    </p>
    {forecast.parts.length > 0 && (
      <ul className='grid gap-1 pl-4' data-testid='forecast-parts'>
        {forecast.parts.map((part) => (
          <li key={part.name} className='list-disc'>
            <span className='font-semibold'>{part.name}</span>
            {part.needs.length > 0 && <span className='text-muted-foreground'>, after {part.needs.join(', ')}</span>}
            <span className='block break-all text-muted-foreground'>{part.files.join(', ')}</span>
          </li>
        ))}
      </ul>
    )}
    {forecast.reference !== null && (
      <div data-testid='forecast-reference'>
        <p className='text-muted-foreground'>Similar past globs: {forecast.reference.summary}</p>
        <ul className='pl-4'>
          {forecast.reference.samples.map((sample) => (
            <li key={sample.globId} className='list-disc'>
              {sample.globId} {sample.title}
              <span className='text-muted-foreground'>
                {' '}
                ({sample.files ?? '?'} files, {sample.lines ?? '?'} lines, {sample.rounds ?? '?'} rounds
                {sample.cleanSub ? ', clean' : ''})
              </span>
            </li>
          ))}
        </ul>
      </div>
    )}
    <p className='text-muted-foreground' data-testid='forecast-calibration'>
      Calibrated x{forecast.calibrated.scale}
      {Object.entries(forecast.calibrated.areaFactors).map(([area, factor]) => ` ${area} x${factor}`).join(',')}; weights code {pct(forecast.weights.code)}, similar
      globs {pct(forecast.weights.reference)}, text {pct(forecast.weights.text)}
    </p>
  </div>
);

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
  // Proposing runs in the background: the button spins until the stored check's time moves (or a minute passes).
  const [proposingFrom, setProposingFrom] = useState<string | null>(null);
  const proposing = proposingFrom !== null && check?.updatedAt === proposingFrom;
  useEffect(() => {
    if (proposingFrom === null) return;
    if (check?.updatedAt !== proposingFrom) {
      setProposingFrom(null);
      onDone();
      return;
    }
    const poll = setInterval(() => void full.refetch(), 2000);
    const stop = setTimeout(() => setProposingFrom(null), 60_000);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [proposingFrom, check?.updatedAt]);
  // The web has no plan hash: a plan saved after the check was last made means the proposal may not reflect it.
  const planSavedAt = (glob.artifacts ?? full.data?.artifacts)?.find((a) => a.kind === 'plan' && a.label === '')?.createdAt;
  const planChanged = check !== undefined && planSavedAt !== undefined && planSavedAt > check.updatedAt;
  const proposeAgain = () => {
    setError(null);
    api.reproposeSplit(glob.id).then(
      () => setProposingFrom(check?.updatedAt ?? ''),
      (e: unknown) => setError(e instanceof RequestError ? e.body.message : 'Could not do that'),
    );
  };
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
        plan: p.plan,
        ...(index > 0 && p.after.length > 0 ? { after: [...p.after] } : {}),
        // Absent in proposals stored before overlaps and low-risk subs existed.
        ...(index > 0 && (p.overlaps?.length ?? 0) > 0 ? { overlaps: [...(p.overlaps ?? [])] } : {}),
        ...(index > 0 && p.type !== undefined ? { type: p.type } : {}),
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
      {check?.estimate.forecast !== undefined && <SizeForecastView forecast={check.estimate.forecast} />}
      {check !== undefined && check.evidence.length > 0 && (
        <ul className='list-disc pl-4 text-muted-foreground'>
          {check.evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {proposal?.criticalPath !== undefined && (
        <p className='text-muted-foreground' data-testid='oversized-shape'>
          Critical path: {proposal.criticalPath} of {proposal.parts.length} parts in a row; up to {proposal.maxParallel ?? 1} at the same time.
        </p>
      )}
      {proposal !== null && (
        <ol className='grid gap-1 pl-4' data-testid='oversized-parts'>
          {proposal.parts.map((p, index) => (
            <li key={index} className='list-decimal'>
              <span className='font-semibold'>{p.title}</span>
              {index === 0 ? ` (stays ${glob.id})` : ''}
              {p.type === 'sub' && <span className='text-muted-foreground'> (sub)</span>}
              {p.after.length > 0 && <span className='text-muted-foreground'>, needs {p.after.map((n) => `part ${n + 1}`).join(', ')}</span>}
              {(p.overlaps?.length ?? 0) > 0 && (
                <span className='text-muted-foreground'>, may overlap {(p.overlaps ?? []).map((n) => `part ${n + 1}`).join(', ')}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {check === undefined ? (
        <p className='text-muted-foreground'>{full.isError ? 'Could not load the proposed split.' : 'Loading the proposed split…'}</p>
      ) : (
        proposal === null && (
          <p className='text-muted-foreground'>No split was proposed (the model gave none). Propose again, or cut it yourself with Edit split.</p>
        )
      )}
      <div className='flex flex-wrap items-center gap-2'>
        {proposal !== null && (
          <Button size='sm' disabled={busy} data-testid='split-as-proposed' onClick={() => void splitAsProposed()}>
            Split as proposed
          </Button>
        )}
        {check !== undefined && (
          <Button size='sm' variant='outline' disabled={busy || proposing} data-testid='propose-split' onClick={proposeAgain}>
            {proposing ? 'Proposing…' : proposal === null ? 'Propose split' : 'Propose again'}
          </Button>
        )}
        {planChanged && <span className='text-muted-foreground' data-testid='plan-changed'>The plan changed since this proposal</span>}
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
