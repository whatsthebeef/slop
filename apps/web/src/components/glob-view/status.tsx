import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { MachineIcon } from '@/components/actor-icons';
import type { GlobView } from '@/lib/api';
import { moveOf, positionOf, stepLabel, stepsOf, stepWords } from '@/lib/position';
import { collapsed, isDismissed, turnKey } from '@/lib/dismissals';
import { stalledHeadline } from '@/lib/card-rows';
import { viewStatusLine } from '@/lib/status-line';
import type { Waiting } from '@/lib/status-line';
import { cn } from '@/lib/utils';
import { HandoverBrief } from './actions';
import type { GlobActionsState } from './actions';

/** The escalation's own words ("Needs a human: <reason>") are the header chip's job, never the headline's. */
const headlineReason = (reason: string): string =>
  /^Needs a human\b/.test(reason) ? 'Needs a person' : reason;

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The small × ("Got it") beside a message: the viewer has read it, so its long text collapses. */
const GotIt = ({ onClick, disabled }: { onClick: () => void; disabled: boolean }) => (
  <button
    type="button"
    className="ml-1 inline-flex cursor-pointer items-center rounded-sm align-middle text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
    aria-label="Got it: collapse this message"
    title="Got it"
    data-testid="dismiss-message"
    disabled={disabled}
    onClick={onClick}
  >
    <X className="size-3" aria-hidden />
  </button>
);

const LinkButton = ({ onClick, disabled, testId, children }: { onClick: () => void; disabled: boolean; testId: string; children: string }) => (
  <button type="button" className="cursor-pointer text-xs underline disabled:opacity-50" data-testid={testId} disabled={disabled} onClick={onClick}>
    {children}
  </button>
);

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
  // Dismissed (per person), the long text collapses to the short label; the main action is untouched.
  const seen = problem === null ? null : collapsed(glob, problem);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [glob.id, seen?.key]);
  const turnDismissed = yours && move.reason !== '' && isDismissed(glob, turnKey(move));
  const session = position?.sessionUrl ?? problem?.sessionUrl ?? null;
  const listed = steps.length > 1;
  const hasDetails = problem !== null || listed || brief !== null;
  if (position === null && !yours && problem === null && steps.length === 0) return null;

  const minutes = position?.minutes ?? null;
  const headline =
    yours ? (
      <>
        <span className="text-muted-foreground">Now: </span>Your turn
        {move.reason !== '' && !turnDismissed && ` · ${headlineReason(move.reason)}`}
        {move.reason !== '' &&
          (turnDismissed ? (
            <span className="font-normal">
              {' · '}
              <LinkButton testId="show-again" disabled={actions.busy} onClick={() => void actions.dismiss(turnKey(move), false)}>
                Show again
              </LinkButton>
            </span>
          ) : (
            <GotIt disabled={actions.busy} onClick={() => void actions.dismiss(turnKey(move), true)} />
          ))}
      </>
    ) : position === null ? null : (
      <>
        <span className="text-muted-foreground">Now: </span>
        {position.holder === 'machine' && <MachineIcon className="mr-1 inline" decorative />}
        {position.holder === 'human' && 'Their turn · '}
        {position.holder === 'stalled' && seen?.dismissed === true
          ? `Stalled · ${seen.label}`
          : position.holder === 'stalled'
            ? capitalised(stalledHeadline(position.label))
            : capitalised(headlineReason(position.text))}
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
        <p className={cn('font-medium', seen?.dismissed === true ? 'text-muted-foreground' : problem.tone)} data-testid="now-headline">
          {seen?.dismissed === true ? capitalised(seen.label) : problem.text}
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
            {problem !== null && seen !== null && seen.dismissed && (
              <p className="text-sm text-muted-foreground" data-testid="status-line" data-kind={problem.kind} data-dismissed="true">
                {capitalised(seen.label)}
                {' · '}
                <LinkButton testId="show-details" disabled={false} onClick={() => setExpanded(!expanded)}>
                  {expanded ? 'hide details' : 'show details'}
                </LinkButton>
                {' · '}
                <LinkButton testId="show-again" disabled={actions.busy} onClick={() => void actions.dismiss(seen.key, false)}>
                  Show again
                </LinkButton>
              </p>
            )}
            {problem !== null && seen !== null && (!seen.dismissed || expanded) && (
              <p className={cn('text-sm', problem.tone)} data-testid="status-line" data-kind={problem.kind}>
                {problem.full}
                {problem.doing !== null && (
                  <span className="font-normal">
                    {' — '}
                    {problem.sessionUrl === null ? (
                      problem.doing
                    ) : (
                      <Link href={problem.sessionUrl}>{problem.doing}</Link>
                    )}
                  </span>
                )}
                {problem.url !== null && (
                  <>
                    {' ('}
                    <Link href={problem.url}>check run</Link>
                    {glob.pr?.headSha != null && !problem.full.includes(glob.pr.headSha.slice(0, 7)) && `, ${glob.pr.headSha.slice(0, 7)}`})
                  </>
                )}
                {!seen.dismissed && problem.kind !== 'rollout' && (
                  <GotIt disabled={actions.busy} onClick={() => void actions.dismiss(seen.key, true)} />
                )}
              </p>
            )}
            {brief !== null && <HandoverBrief state={actions} brief={brief} />}
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
