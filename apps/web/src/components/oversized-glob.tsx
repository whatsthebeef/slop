import { useQuery } from '@tanstack/react-query';
import type { SizeForecast } from '@slop/core';
import { useEffect, useState } from 'react';
import { api, RequestError } from '@/lib/api';
import type { GlobView, SplitPartInput } from '@/lib/api';

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
 * The size check's answer for a flagged glob, as the moves the actions menu offers: Split as proposed calls the split
 * service with the proposal; Keep whole records the decision (it is read as an outcome when the glob merges) and starts a
 * glob that was held for the flag; Propose again asks for a new proposal. Edit split is the page's split form.
 */
export const useOversized = ({
  glob,
  enabled,
  onDone,
}: {
  glob: GlobView;
  /** Only an oversized glob loads or acts on the proposal. */
  enabled: boolean;
  /** After a split or Keep whole: the caller refreshes the board. */
  onDone: () => void;
}) => {
  // The board list carries only the flag; the proposal comes with the single-glob read.
  const full = useQuery({
    queryKey: ['size-check', glob.id],
    queryFn: () => api.glob(glob.id),
    enabled: enabled && glob.sizeCheck === undefined,
  });
  const check = glob.sizeCheck ?? full.data?.sizeCheck;
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingKeep, setConfirmingKeep] = useState(false);
  const proposal = check?.proposal ?? null;
  // Proposing runs in the background: the menu spins until the stored check's time moves (or a minute passes).
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
  useEffect(() => {
    setConfirmingKeep(false);
    setError(null);
  }, [glob.id]);
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
        // Absent in proposals stored before low-risk subs existed.
        ...(index > 0 && p.type !== undefined ? { type: p.type } : {}),
      }));
      return api.splitGlob(glob.id, glob.version, parts, key);
    });
  const keepWhole = () => {
    setConfirmingKeep(false);
    return act(() => api.keepWhole(glob.id));
  };
  return {
    check,
    loadFailed: full.isError,
    proposal,
    planChanged,
    busy,
    proposing,
    error,
    confirmingKeep,
    setConfirmingKeep,
    splitAsProposed,
    proposeAgain,
    keepWhole,
  };
};

export type OversizedState = ReturnType<typeof useOversized>;

/**
 * The size check's explanation for a flagged glob: why it is flagged, the forecast, the proposed parts and whether the
 * plan changed since. It has no buttons: the answers (Split as proposed, Edit split, Propose again, Keep whole) are in the
 * glob's actions.
 */
export const OversizedGlob = ({ glob, size }: { glob: GlobView; size: OversizedState }) => {
  const { check, proposal, planChanged } = size;
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
            </li>
          ))}
        </ol>
      )}
      {check === undefined ? (
        <p className='text-muted-foreground'>{size.loadFailed ? 'Could not load the proposed split.' : 'Loading the proposed split…'}</p>
      ) : (
        proposal === null && (
          <p className='text-muted-foreground'>No split was proposed (the model gave none). Propose again, or cut it yourself with Edit split.</p>
        )
      )}
      {planChanged && (
        <p className='text-muted-foreground' data-testid='plan-changed'>
          The plan changed since this proposal
        </p>
      )}
    </div>
  );
};
