import { useEffect, useState } from 'react';
import { MachineIcon } from '@/components/actor-icons';
import type { GlobView } from '@/lib/api';
import { moveOf, positionOf, stepLabel, stepsOf, stepWords } from '@/lib/position';
import { viewStatusLine } from '@/lib/status-line';
import type { Waiting } from '@/lib/status-line';
import { cn } from '@/lib/utils';
import { HandoverBrief } from './actions';
import type { GlobActionsState } from './actions';

/** The escalation's own words ("Needs a human: <reason>") are the header chip's job, never the headline's. */
const headlineReason = (reason: string): string =>
  /^Needs a human\b/.test(reason) ? 'Needs a person' : reason;

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const Link = ({ href, children }: { href: string; children: string }) => (
  <a className="underline" href={href} target="_blank" rel="noreferrer">
    {children}
  </a>
);

/**
 * The one "Now" panel at the top of the glob view: a headline saying who holds the ball and what, and the detail behind it
 * (the failing check once, its run, the head, the session, the machine steps, and for the viewer's own turn the handover
 * brief) collapsed under one toggle. Replaces the separate Now row, status line, Machine steps list and handover box.
 */
export const NowPanel = ({
  glob,
  decision,
  disabled,
  actions,
}: {
  glob: GlobView;
  decision: boolean;
  disabled: readonly Waiting[];
  actions: GlobActionsState;
}) => {
  const now = new Date().toISOString();
  const position = decision ? null : positionOf(glob, now);
  const move = decision ? null : moveOf(glob, now);
  const status = viewStatusLine(glob, now, disabled);
  const steps = decision ? [] : stepsOf(glob).filter((s) => s.state !== 'done');
  const yours = move?.holder === 'you';
  // The handover brief is for whoever holds the ball: the viewer's turn, or a stall handed to them.
  const brief =
    actions.brief !== null && (yours || move?.holder === 'stalled') ? actions.brief : null;
  const unread = brief !== null && !actions.briefRead;
  const [open, setOpen] = useState(unread);
  useEffect(() => setOpen(unread), [glob.id, unread]);

  // A status line that only says "Your turn" repeats the headline.
  const problem = status !== null && status.kind !== 'ready' ? status : null;
  const session = position?.sessionUrl ?? problem?.sessionUrl ?? null;
  const listed = steps.length > 1;
  const hasDetails = problem !== null || listed || brief !== null || session !== null;
  if (position === null && !yours && problem === null && steps.length === 0) return null;

  const minutes = position?.minutes ?? null;
  const headline =
    yours ? (
      <>
        <span className="text-muted-foreground">Now: </span>Your turn
        {move.reason !== '' && ` · ${headlineReason(move.reason)}`}
      </>
    ) : position === null ? null : (
      <>
        <span className="text-muted-foreground">Now: </span>
        {position.holder === 'machine' && <MachineIcon className="mr-1 inline" decorative />}
        {position.holder === 'human' && 'Their turn · '}
        {capitalised(headlineReason(position.text))}
        {minutes !== null && minutes > 0 && (
          <span className="font-normal text-muted-foreground"> · {minutes} min</span>
        )}
        {session !== null && (
          <span className="font-normal">
            {' · '}
            <Link href={session}>Open session</Link>
          </span>
        )}
      </>
    );

  return (
    <div
      className="grid gap-1 text-sm"
      data-testid="now-panel"
      data-holder={move?.holder ?? 'none'}
    >
      {headline !== null && (
        <p className={cn('font-medium', position?.tone)} data-testid="now-headline">
          {headline}
        </p>
      )}
      {headline === null && problem !== null && (
        <p className={cn('font-medium', problem.tone)} data-testid="now-headline">
          {problem.text}
        </p>
      )}
      {hasDetails && (
        <details
          open={open}
          onToggle={(e) => setOpen(e.currentTarget.open)}
          data-testid="now-details"
        >
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {open ? 'Hide details' : 'Show details'}
          </summary>
          <div className="mt-1 grid gap-2">
            {problem !== null && (
              <p className={cn('text-sm', problem.tone)} data-testid="status-line" data-kind={problem.kind}>
                {problem.full}
                {problem.doing !== null && <span className="font-normal">{` — ${problem.doing}`}</span>}
                {problem.url !== null && (
                  <>
                    {' ('}
                    <Link href={problem.url}>check run</Link>
                    {glob.pr?.headSha != null && !problem.full.includes(glob.pr.headSha.slice(0, 7)) && `, ${glob.pr.headSha.slice(0, 7)}`})
                  </>
                )}
              </p>
            )}
            {brief !== null && <HandoverBrief glob={glob} state={actions} brief={brief} />}
            {listed && (
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
                          <Link href={step.detail}>open</Link>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </details>
      )}
    </div>
  );
};
