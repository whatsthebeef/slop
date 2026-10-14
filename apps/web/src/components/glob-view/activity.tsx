import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { GitPullRequest, TriangleAlert } from 'lucide-react';
import { HumanIcon, MachineIcon } from '@/components/actor-icons';
import { ACTIVITY_SHOWN, activityOf } from '@/lib/activity';
import type { ActivityEntry } from '@/lib/activity';
import { turnKey } from '@/lib/dismissals';
import { stepLabel, stepWords } from '@/lib/position';
import { cn } from '@/lib/utils';
import { HandoverBrief } from './actions';
import type { GlobActionsState } from './actions';
import type { GlobViewContext } from './context';
import { ACTIVITY_ID, GotIt, Link, LinkButton, capitalised, headlineReason, shownElsewhere } from './status';
import type { NowState } from './status';

const relative = (iso: string | null, now: number): string => {
  if (iso === null) return '';
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${String(hours)} h ago` : `${String(Math.round(hours / 24))} d ago`;
};

const ActorMark = ({ actor }: { actor: ActivityEntry['actor'] }) =>
  actor === 'machine' ? (
    <MachineIcon decorative />
  ) : actor === 'human' ? (
    <HumanIcon decorative />
  ) : actor === 'github' ? (
    <GitPullRequest className="size-3.5" aria-hidden />
  ) : (
    <TriangleAlert className="size-3.5 text-required" aria-hidden />
  );

const Entry = ({ entry, now }: { entry: ActivityEntry; now: number }) => {
  const [open, setOpen] = useState(false);
  const external = entry.link !== null && /^https?:\/\//.test(entry.link);
  return (
    <li className="grid gap-0.5" data-testid="activity-entry" data-actor={entry.actor}>
      <div className="flex items-center gap-2">
        <ActorMark actor={entry.actor} />
        <span className="min-w-0 flex-1 truncate" title={entry.text}>
          {entry.text}
          {entry.count > 1 && ` ×${String(entry.count)}`}
        </span>
        {entry.link !== null &&
          (external ? (
            <a className="shrink-0 underline" href={entry.link} target="_blank" rel="noreferrer">
              open
            </a>
          ) : (
            <RouterLink className="shrink-0 underline" to={entry.link}>
              open
            </RouterLink>
          ))}
        {entry.more.length > 0 && (
          <LinkButton testId="activity-expand" disabled={false} onClick={() => setOpen(!open)}>
            {open ? 'less' : 'more'}
          </LinkButton>
        )}
        <span className="w-16 shrink-0 text-right text-muted-foreground">{relative(entry.at, now)}</span>
      </div>
      {open && (
        <pre className="ml-6 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground" data-testid="activity-more">
          {entry.more.join('\n')}
        </pre>
      )}
    </li>
  );
};

/**
 * The glob's Activity log, right under the action button: the pinned entries that need the viewer (the status's full text,
 * the handover brief, the machine steps) and a short feed of what happened (runs, PR, checks, conflicts, human actions),
 * the last few lines with "Show all".
 */
export const ActivityLog = ({
  ctx: { board, glob },
  state,
  actions,
}: {
  ctx: GlobViewContext;
  state: NowState;
  actions: GlobActionsState;
}) => {
  const { move, turn, steps, brief, problem, seen, turnDismissed, position } = state;
  const [expanded, setExpanded] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => {
    setExpanded(false);
    setAll(false);
  }, [glob.id, seen?.key]);
  const feed = activityOf(glob, board.repo);
  const shown = all ? feed : feed.slice(0, ACTIVITY_SHOWN);
  const session = position?.sessionUrl ?? problem?.sessionUrl ?? null;
  const listed = steps.length > 1;
  const now = Date.now();
  return (
    <section id={ACTIVITY_ID} className="grid scroll-mt-[calc(var(--glob-header-height,2.5rem)+0.5rem)] gap-1.5 text-sm" data-testid="activity" data-holder={move?.holder ?? 'none'}>
      <h3 className="text-xs font-semibold text-muted-foreground">Activity</h3>
      <div className="grid gap-2" data-testid="activity-pinned">
        {turn !== null && turn.reason !== '' && (
          <p className="font-medium" data-testid="turn-reason">
            Your turn · {headlineReason(turn.reason)}
            {turnDismissed ? (
              <span className="font-normal">
                {' · '}
                <LinkButton testId="show-again" disabled={actions.busy} onClick={() => void actions.dismiss(turnKey(turn), false)}>
                  Show again
                </LinkButton>
              </span>
            ) : (
              <GotIt disabled={actions.busy} onClick={() => void actions.dismiss(turnKey(turn), true)} />
            )}
          </p>
        )}
        {session !== null && (
          <p className="text-xs">
            <Link href={session}>Open session</Link>
          </p>
        )}
        {problem !== null && seen !== null && seen.dismissed && (
          <p className="text-muted-foreground" data-testid="status-line" data-kind={problem.kind} data-dismissed="true">
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
          <p className={cn(problem.tone)} data-testid="status-line" data-kind={problem.kind}>
            {problem.full}
            {problem.doing !== null && (
              <span className="font-normal">
                {' — '}
                {problem.sessionUrl === null ? problem.doing : <Link href={problem.sessionUrl}>{problem.doing}</Link>}
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
        {brief !== null && <HandoverBrief state={actions} brief={brief} omit={shownElsewhere(glob, problem)} />}
        {listed && (
          <details data-testid="machine-steps">
            <summary className="cursor-pointer text-xs text-muted-foreground">Machine steps ({steps.length})</summary>
            <ul className="mt-1 space-y-0.5 text-xs">
              {steps.map((step) => (
                <li key={step.id} data-kind={step.kind} data-state={step.state}>
                  {stepLabel(step)} <span className="text-muted-foreground">{stepWords(step, state.now)}</span>
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
      <ul className="grid gap-1 text-xs" data-testid="activity-feed">
        {shown.map((entry) => (
          <Entry key={entry.id} entry={entry} now={now} />
        ))}
      </ul>
      {feed.length > ACTIVITY_SHOWN && (
        <LinkButton testId="activity-show-all" disabled={false} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all (${String(feed.length)})`}
        </LinkButton>
      )}
    </section>
  );
};
