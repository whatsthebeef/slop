import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { GitPullRequest, TriangleAlert } from 'lucide-react';
import { HumanIcon, MachineIcon } from '@/components/actor-icons';
import { ACTIVITY_SHOWN, activityOf } from '@/lib/activity';
import type { ActivityEntry } from '@/lib/activity';
import { turnKey } from '@/lib/dismissals';
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
  const external = entry.link !== null && /^https?:\/\//.test(entry.link);
  return (
    <li className="flex items-center gap-2" data-testid="activity-entry" data-actor={entry.actor} title={entry.title}>
      <ActorMark actor={entry.actor} />
      <span className="min-w-0 flex-1 truncate">
        {entry.text}
        {entry.count > 1 && ` ×${String(entry.count)}`}
      </span>
      {entry.link !== null &&
        (external ? (
          <a className="shrink-0 underline" href={entry.link} target="_blank" rel="noreferrer">
            {entry.linkLabel}
          </a>
        ) : (
          <RouterLink className="shrink-0 underline" to={entry.link}>
            {entry.linkLabel}
          </RouterLink>
        ))}
      <span className="w-16 shrink-0 text-right text-muted-foreground">{relative(entry.at, now)}</span>
    </li>
  );
};

/**
 * The glob's Activity log, right under the action button: the pinned entries that need the viewer (the status's full text,
 * the handover brief) and a flat feed of what happened (machine steps, runs, PR, checks, conflicts, human actions), one line each: the last
 * few with "Show all", the only control in it.
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
  const { move, turn, steps, brief, problem, seen, turnDismissed } = state;
  const [all, setAll] = useState(false);
  useEffect(() => {
    setAll(false);
  }, [glob.id, seen?.key]);
  const feed = activityOf(glob, board.repo, steps);
  const shown = all ? feed : feed.slice(0, ACTIVITY_SHOWN);
  const now = Date.now();
  return (
    <section id={ACTIVITY_ID} className="grid scroll-mt-[calc(var(--glob-header-height,2.25rem)+0.5rem)] gap-1.5 text-sm" data-testid="activity" data-holder={move?.holder ?? 'none'}>
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
        {problem !== null && seen !== null && seen.dismissed && (
          <p className="text-muted-foreground" data-testid="status-line" data-kind={problem.kind} data-dismissed="true">
            {capitalised(seen.label)}
            {' · '}
            <LinkButton testId="show-again" disabled={actions.busy} onClick={() => void actions.dismiss(seen.key, false)}>
              Show again
            </LinkButton>
          </p>
        )}
        {problem !== null && seen !== null && !seen.dismissed && (
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
            {problem.kind !== 'rollout' && (
              <GotIt disabled={actions.busy} onClick={() => void actions.dismiss(seen.key, true)} />
            )}
          </p>
        )}
        {brief !== null && <HandoverBrief state={actions} brief={brief} omit={shownElsewhere(glob, problem)} />}
      </div>
      <ul className="grid gap-1 text-xs" data-testid="activity-feed">
        {shown.map((entry) => (
          <Entry key={entry.id} entry={entry} now={now} />
        ))}
      </ul>
      {feed.length > ACTIVITY_SHOWN && (
        <LinkButton testId="activity-show-all" disabled={false} onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all (${String(feed.length)})`}
        </LinkButton>
      )}
    </section>
  );
};
