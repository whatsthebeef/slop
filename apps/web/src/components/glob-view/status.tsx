import { X } from 'lucide-react';
import { CategoryIcon } from '@/components/glob-card';
import { StatusIconView } from '@/components/status-icon';
import type { GlobView } from '@/lib/api';
import { moveOf, positionOf, stepsOf } from '@/lib/position';
import { collapsed, isDismissed, turnKey } from '@/lib/dismissals';
import { cornerStatus, plainText } from '@/lib/card-rows';
import { rolloutLine } from '@/lib/human-steps';
import { viewStatusLine } from '@/lib/status-line';
import type { Waiting } from '@/lib/status-line';
import { cn } from '@/lib/utils';
import type { GlobActionsState } from './actions';

/** The dot between the top bar's parts. */
export const Dot = () => (
  <span aria-hidden className="-mx-1 shrink-0 text-muted-foreground" data-testid="header-dot">
    ·
  </span>
);

/** The escalation's own words ("Needs a human: <reason>") are the header chip's job, never the headline's. */
export const headlineReason = (reason: string): string =>
  /^Needs a human\b/.test(reason) ? 'Needs a person' : reason;

/**
 * The brief's lines the panel already shows through the status line: the failure's reason when that line is the reason
 * itself, and the decision (the status line says it as "Needs a person: <decision>").
 */
export const shownElsewhere = (glob: GlobView, problem: { readonly kind: string } | null): string[] => {
  const failure = glob.failure;
  if (failure == null || problem?.kind !== 'failure') return [];
  const decision = failure.kind === 'needs_pairing' ? failure.decision?.trim() : undefined;
  return [
    ...(decision === undefined || decision === '' ? [`Failed: ${failure.reason}`] : [`Decision needed: ${decision}`]),
  ];
};

export const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The small × ("Got it") beside a message: the viewer has read it, so its long text collapses. */
export const GotIt = ({ onClick, disabled }: { onClick: () => void; disabled: boolean }) => (
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

/** The coarse lifecycle text, for a glob nobody is moving and nothing is wrong with. */
const STATUS_TEXT: Record<GlobView['status'], string> = {
  planning: 'Planning',
  implementing: 'A routine is implementing',
  in_progress: 'In progress',
  failed: 'Failed',
  pr_open: 'PR open for review',
  merging: 'Merging',
  reviewing: 'Merged; awaiting sign-off',
  signed_off: 'Signed off',
};

/** A decision glob uses the same lists for a different journey: it is decided in Doing and signed off once accepted. */
const DECISION_STATUS_TEXT: Partial<Record<GlobView['status'], string>> = {
  in_progress: 'Doing: being decided',
  reviewing: 'Decided; awaiting sign-off',
};

/** The id of the Activity log, which the header's status scrolls to. */
export const ACTIVITY_ID = 'glob-activity';

/** Everything the header status and the Activity log's pinned entries are worked out from, once. */
export const useNowState = (glob: GlobView, decision: boolean, disabled: readonly Waiting[], actions: GlobActionsState) => {
  const now = new Date().toISOString();
  const position = decision ? null : positionOf(glob, now);
  const move = decision ? null : moveOf(glob, now);
  const status = viewStatusLine(glob, now, disabled);
  const steps = decision ? [] : stepsOf(glob).filter((s) => s.state !== 'done');
  const turn = move?.holder === 'you' ? move : null;
  const yours = turn !== null;
  // The handover brief is for whoever holds the ball: the viewer's turn, or a stall handed to them.
  const brief = actions.brief !== null && (yours || move?.holder === 'stalled') ? actions.brief : null;
  // A status line that only says "Your turn" repeats the headline.
  const problem = status !== null && status.kind !== 'ready' ? status : null;
  // Dismissed (per person), the long text collapses to the short label; the main action is untouched.
  const seen = problem === null ? null : collapsed(glob, problem);
  const turnDismissed = turn !== null && turn.reason !== '' && isDismissed(glob, turnKey(turn));
  return { now, viewer: actions.viewer, position, move, turn, steps, yours, brief, problem, seen, turnDismissed };
};

export type NowState = ReturnType<typeof useNowState>;

/**
 * The status in the header's top right, one line and truncated: the machine's or the person's position, else the problem,
 * else the lifecycle text. Clicking it opens a live run's session, else scrolls to the Activity log, where its details are.
 */
export const HeaderStatus = ({ glob, decision, state }: { glob: GlobView; decision: boolean; state: NowState }) => {
  const { position, move, turn, problem, seen, turnDismissed, now, viewer } = state;
  // The same status as the card's top right, word for word; the lifecycle text only where it has nothing to say.
  const corner = decision ? null : cornerStatus(glob, now, viewer);
  const rollout = decision ? null : rolloutLine(glob, glob.humanSteps ?? [], undefined);
  // Decision globs have no corner status; their fallback text still gets the person's icon when it is the viewer's turn.
  const rawText =
    corner !== null
      ? corner.text
      : turn !== null
        ? `Your turn${turn.reason !== '' && !turnDismissed ? ` · ${headlineReason(turn.reason)}` : ''}`
        : problem !== null
          ? seen?.dismissed === true
            ? capitalised(seen.label)
            : problem.text
          : (rollout?.text ?? (decision ? DECISION_STATUS_TEXT[glob.status] : undefined) ?? STATUS_TEXT[glob.status]);
  const text = corner !== null ? rawText : plainText(rawText);
  const icon = corner?.icon ?? (turn !== null || rollout?.turn != null ? 'human' : null);
  const tone = corner !== null ? corner.tone : turn !== null ? undefined : seen?.dismissed === true ? 'text-muted-foreground' : problem?.tone;
  // A live run's status opens that run's session; the activity log has no session link of its own beyond its run entries.
  const live = position?.holder === 'machine' ? position.sessionUrl : null;
  return (
    <span className="ml-auto inline-flex min-w-0 items-center gap-2" data-testid="header-corner">
      <button
        type="button"
        className={cn('inline-flex min-w-0 cursor-pointer items-center gap-1 rounded px-1 text-right text-sm font-medium hover:bg-muted', tone)}
        aria-label={corner?.kind === 'needs-human' ? corner.label : undefined}
        title={live !== null ? "Open the machine's session" : (corner?.tip ?? rollout?.tip ?? position?.tip ?? problem?.full ?? text)}
        data-testid="header-status"
        data-holder={move?.holder ?? 'none'}
        onClick={() =>
          live !== null ? window.open(live, '_blank', 'noreferrer') : document.getElementById(ACTIVITY_ID)?.scrollIntoView({ block: 'start' })
        }
      >
        {/* The text gives way (ellipsis) only when the row is full; the ID before it never shrinks. */}
        <span className="truncate" data-testid="header-status-text">
          {text}
        </span>
        {icon !== null && <StatusIconView icon={icon} />}
      </button>
      {text !== '' && <Dot />}
      <CategoryIcon category={glob.category} />
    </span>
  );
};
