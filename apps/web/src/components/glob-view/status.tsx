import { isHumanCategory, moveOf } from '@slop/core';
import { KindMarker } from '@/components/glob-card';
import { StatusIconView } from '@/components/status-icon';
import type { GlobView } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { GlobActionsState } from './actions';

/** The dot between the top bar's parts. */
export const Dot = () => (
  <span aria-hidden className="-mx-1 shrink-0 text-muted-foreground" data-testid="header-dot">
    ·
  </span>
);

export const LinkButton = ({ onClick, disabled, testId, children }: { onClick: () => void; disabled: boolean; testId: string; children: string }) => (
  <button type="button" className="cursor-pointer text-xs underline disabled:opacity-50" data-testid={testId} disabled={disabled} onClick={onClick}>
    {children}
  </button>
);

export const Link = ({ href, children }: { href: string; children: string }) => (
  <a className="underline" href={href} target="_blank" rel="noreferrer">
    {children}
  </a>
);

/** The id of the Activity log, which the header's status scrolls to. */
export const ACTIVITY_ID = 'glob-activity';

/** What the header status and the Activity log read: the presentation (one per page, made by `useGlobActions`) and whose move it is. */
export const useNowState = (glob: GlobView, decision: boolean, actions: GlobActionsState) => {
  const now = new Date().toISOString();
  const move = decision ? null : moveOf(glob, now);
  return { now, viewer: actions.viewer, base: actions.base, presentation: actions.presentation, move };
};

export type NowState = ReturnType<typeof useNowState>;

/**
 * The header's top right, as on the card: the status, a dot, then the fix marker. The status is exactly the card's (`presentGlob`'s
 * `status`: text, icon, tooltip, in-progress after a click included) and is left out, with its dot, when the card has none; the list is
 * never shown here (it sits by the ID). It is text and an icon: clicking it scrolls to the Activity log, and it never runs an action.
 */
export const HeaderStatus = ({ glob, state }: { glob: GlobView; state: NowState }) => {
  // A decision or an action glob shows no status of its own up here (its blocks say it), except a click in progress.
  const status = state.presentation.status;
  const corner = status !== null && isHumanCategory(glob.category) && status.kind !== 'pending' ? null : status;
  return (
    <span className="ml-auto inline-flex min-w-0 items-center gap-2" data-testid="header-corner">
      {corner !== null && (
        <>
          <button
            type="button"
            className={cn('inline-flex min-w-0 cursor-pointer items-center gap-1 rounded px-1 text-right text-sm font-medium hover:bg-muted', corner.tone)}
            aria-label={corner.kind === 'needs-human' ? corner.label : undefined}
            title={corner.tip}
            data-testid="header-status"
            data-kind={corner.kind}
            data-icon={corner.icon}
            data-holder={state.move?.holder ?? 'none'}
            onClick={() => document.getElementById(ACTIVITY_ID)?.scrollIntoView({ block: 'start' })}
          >
            {/* The text gives way (ellipsis) only when the row is full; the ID before it never shrinks. */}
            <span className="truncate" data-testid="header-status-text">
              {corner.text}
            </span>
            <StatusIconView icon={corner.icon} />
          </button>
          <Dot />
        </>
      )}
      <span className="ml-1.5 inline-flex">
        <KindMarker glob={glob} />
      </span>
    </span>
  );
};
