import type { GlobView } from '@/lib/api';
import { moveOf, positionOf, stepLabel, stepsOf, stepWords } from '@/lib/position';
import { viewStatusLine } from '@/lib/status-line';
import type { Waiting } from '@/lib/status-line';
import { cn } from '@/lib/utils';

/** The "Now" row at the top of the actions area: who has the ball, why and for how long, and the machine steps behind it. */
export const NowRow = ({ glob }: { glob: GlobView }) => {
  const now = new Date().toISOString();
  const position = positionOf(glob, now);
  const move = moveOf(glob, now);
  const steps = stepsOf(glob).filter((s) => s.state !== 'done');
  if (position === null && steps.length === 0 && move.holder !== 'you') return null;
  const holder =
    move.holder === 'you'
      ? 'Your turn'
      : position === null
        ? ''
        : { human: 'Their turn', machine: 'Machine', waiting: 'Waiting', stalled: 'Stalled' }[
            position.holder
          ];
  const minutes = position?.minutes ?? null;
  return (
    <div className="text-sm" data-testid="now-row" data-holder={move.holder}>
      <p className={cn('font-medium', position?.tone)}>
        <span className="text-muted-foreground">Now: </span>
        {holder}
        {move.reason !== '' && ` · ${move.reason}`}
        {minutes !== null && minutes > 0 && (
          <span className="font-normal text-muted-foreground"> · {minutes} min</span>
        )}
      </p>
      {steps.length > 0 && (
        <details data-testid="machine-steps">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Machine steps ({steps.length})
          </summary>
          <ul className="mt-1 space-y-0.5 text-xs">
            {steps.map((step) => (
              <li key={step.id} data-kind={step.kind} data-state={step.state}>
                {stepLabel(step)}{' '}
                <span className="text-muted-foreground">{stepWords(step, now)}</span>
                {step.detail !== null && /^https?:\/\//.test(step.detail) && (
                  <>
                    {' '}
                    <a className="underline" href={step.detail} target="_blank" rel="noreferrer">
                      open
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

/** The one-line status under the chips: what the glob is doing, its failing check and the session working on it. */
export const StatusLine = ({
  glob,
  disabled,
}: {
  glob: GlobView;
  disabled: readonly Waiting[];
}) => {
  const status = viewStatusLine(glob, new Date().toISOString(), disabled);
  if (status === null) return null;
  return (
    <p
      className={cn('text-sm font-medium', status.tone)}
      data-testid="status-line"
      data-kind={status.kind}
    >
      {status.full}
      {status.url !== null && (
        <>
          {' ('}
          <a className="underline" href={status.url} target="_blank" rel="noreferrer">
            check run
          </a>
          )
        </>
      )}
      {status.doing !== null && (
        <span className="font-normal">
          {' — '}
          {status.sessionUrl === null ? (
            status.doing
          ) : (
            <a className="underline" href={status.sessionUrl} target="_blank" rel="noreferrer">
              {status.doing}
            </a>
          )}
        </span>
      )}
    </p>
  );
};
