import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { GitPullRequest, TriangleAlert } from 'lucide-react';
import { HumanIcon, MachineIcon } from '@/components/actor-icons';
import { ACTIVITY_SHOWN, CONTINUE_LOCALLY_TITLE, activityOf } from '@/lib/activity';
import type { ActivityEntry } from '@/lib/activity';
import { turnKey } from '@/lib/dismissals';
import type { GlobActionsState } from './actions';
import type { GlobViewContext } from './context';
import { ACTIVITY_ID, GotIt, LinkButton, headlineReason } from './status';
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
    <li className="flex min-w-0 items-center gap-2" data-testid="activity-entry" data-actor={entry.actor} title={entry.title}>
      <ActorMark actor={entry.actor} />
      <span className="min-w-0 flex-1 truncate">
        {entry.text}
        {entry.count > 1 && ` ×${String(entry.count)}`}
      </span>
      {entry.command !== null && (
        <code className="shrink-0 rounded bg-muted px-1.5 py-0.5" title={CONTINUE_LOCALLY_TITLE} data-testid="continue-locally">
          {entry.command}
        </code>
      )}
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
 * The glob's Activity log, right under the action button: the viewer's turn line and a flat feed of what happened (machine steps, runs, PR, checks, conflicts, human actions), one line each: the last
 * few with "Show all", the only control in it.
 */
export const ActivityLog = ({
  ctx,
  state,
  actions,
}: {
  ctx: GlobViewContext;
  state: NowState;
  actions: GlobActionsState;
}) => {
  const { board, glob } = ctx;
  const { move, turn, steps, problem, turnDismissed } = state;
  const [all, setAll] = useState(false);
  useEffect(() => {
    setAll(false);
  }, [glob.id, problem?.kind]);
  const feed = activityOf(glob, board.repo, steps, actions.viewer?.email);
  const shown = all ? feed : feed.slice(0, ACTIVITY_SHOWN);
  const now = Date.now();
  return (
    <section id={ACTIVITY_ID} className="grid min-w-0 grid-cols-[minmax(0,1fr)] scroll-mt-[calc(var(--glob-header-height,2.25rem)+0.5rem)] gap-1.5 text-sm" data-testid="activity" data-holder={move?.holder ?? 'none'}>
      <h3 className="text-xs font-semibold text-muted-foreground">Activity</h3>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 break-words" data-testid="activity-pinned">
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
      </div>
      <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-xs" data-testid="activity-feed">
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
