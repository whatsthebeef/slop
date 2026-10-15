import { useQuery } from '@tanstack/react-query';
import type { SizeForecast } from '@slop/core';
import { api } from '@/lib/api';
import type { GlobView } from '@/lib/api';

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

/** Whether the glob carries an oversized flag (advice only) and hasn't started. */
export const isOversized = (glob: GlobView): boolean => glob.oversized === true && glob.status === 'planning';

/**
 * The size check's advice for a flagged glob: it loads the single-glob read that carries the proposed workstreams. The flag
 * never holds the glob; splitting is the page's split form (a scope cut into independent globs).
 */
export const useOversized = ({
  glob,
  enabled,
}: {
  glob: GlobView;
  /** Only an oversized glob loads the proposal. */
  enabled: boolean;
}) => {
  // The board list carries only the flag; the proposal comes with the single-glob read.
  const full = useQuery({
    queryKey: ['size-check', glob.id],
    queryFn: () => api.glob(glob.id),
    enabled: enabled && glob.sizeCheck === undefined,
  });
  const check = glob.sizeCheck ?? full.data?.sizeCheck;
  const proposal = check?.proposal ?? null;
  // The web has no plan hash: a plan saved after the check was last made means the proposal may not reflect it.
  const planSavedAt = (glob.artifacts ?? full.data?.artifacts)?.find((a) => a.kind === 'plan' && a.label === '')?.createdAt;
  const planChanged = check !== undefined && planSavedAt !== undefined && planSavedAt > check.updatedAt;
  return {
    check,
    loadFailed: full.isError,
    proposal,
    planChanged,
  };
};

export type OversizedState = ReturnType<typeof useOversized>;

/** The size check's advice for a flagged glob: why it is flagged, the forecast, the proposed workstreams and whether the plan changed since. */
export const OversizedGlob = ({ glob, size }: { glob: GlobView; size: OversizedState }) => {
  const { check, proposal, planChanged } = size;
  return (
    <div className='grid gap-2 rounded border border-amber/60 bg-amber/10 p-3 text-xs' data-testid='oversized-proposal'>
      <p className='font-semibold'>Oversized: this looks like more than one PR's worth of work</p>
      {check !== undefined && (
        <p className='text-muted-foreground'>
          {check.reasons.join('; ')}. This is advice: {glob.id} can start as it is{proposal !== null && ', and the run works the workstreams in parallel'}.
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
          Critical path: {proposal.criticalPath} of {proposal.workstreams.length} workstreams in a row; up to {proposal.maxParallel ?? 1} at the same time.
        </p>
      )}
      {proposal !== null && (
        <ol className='grid gap-1 pl-4' data-testid='oversized-parts'>
          {proposal.workstreams.map((w, index) => (
            <li key={index} className='list-decimal'>
              <span className='font-semibold'>{w.name}</span>
              {w.needs.length > 0 && <span className='text-muted-foreground'>, needs {w.needs.map((n) => `workstream ${n + 1}`).join(', ')}</span>}
              {w.files.length > 0 && (
                <span className='block break-all text-muted-foreground' data-testid='oversized-part-files'>
                  {w.files.join(', ')}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {check === undefined && <p className='text-muted-foreground'>{size.loadFailed ? 'Could not load the proposed workstreams.' : 'Loading the proposed workstreams…'}</p>}
      {planChanged && (
        <p className='text-muted-foreground' data-testid='plan-changed'>
          The plan changed since this proposal
        </p>
      )}
    </div>
  );
};
