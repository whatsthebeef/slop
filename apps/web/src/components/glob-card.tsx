import { armLabel, cardTargets, isHumanCategory, modeOf, stripMarkdown, workKindOf } from '@slop/core';
import type { Action, ArmLabel, CornerStatus, GlobTarget, HumanStepViewer, PendingAction } from '@slop/core';
import { Bug, ListChecks, Rocket, Scale, Sparkles } from 'lucide-react';
import type { ComponentType } from 'react';
import { ActorIcon, MachineIcon, PersonRunning } from '@/components/actor-icons';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import type { AtfRun, GlobView } from '@/lib/api';
import type { MoveTag } from '@/lib/board-motion';
import { kindOf } from '@/lib/board-filters';
import type { Kind } from '@/lib/board-filters';
import { StatusIconView } from '@/components/status-icon';
import { cn, groupSticker } from '@/lib/utils';
import { cardMoveOf, presentOf } from '@/lib/present';
import type { CardMove } from '@/lib/present';
import { useConfirmClick } from '@/lib/use-confirm-click';
import { Tip } from './ui/tip';
import { LabelPopover } from './labels';
import type { ReviewLabel } from './labels';
import { TAG } from './glob-view/tag-style';

/** The small dot between a header's values: the card's ID and type, its status and fix marker, and the glob view's header. */
export const DotSeparator = ({ testId }: { testId?: string }) => (
  <span aria-hidden='true' className='shrink-0' data-testid={testId}>
    ·
  </span>
);

/** A small icon in the card's corner. */
type MarkerGlyph = ComponentType<{ className?: string; 'aria-label'?: string; role?: 'img' }>;

/** The icon of each kind: the card's corner shows it, and so does the board's filter chip. */
export const KIND_ICON: Record<Kind, { icon: MarkerGlyph; className: string; label: string }> = {
  task: { icon: ListChecks, className: 'text-muted-foreground', label: 'Task' },
  bug: { icon: Bug, className: 'text-red', label: 'Bug' },
  // A running person, not the person icon of the human actor and "Picked up", which in the corner would read as a status.
  action: { icon: PersonRunning, className: 'text-muted-foreground', label: 'Action' },
  decision: { icon: Scale, className: 'text-muted-foreground', label: 'Decision' },
};

/** The feature icon: shown in place of the task icon for work counted as R&D. */
const FEATURE_ICON = { icon: Sparkles, className: 'text-muted-foreground', label: 'Feature (R&D)' };

/** The corner marker of every glob: the icon of its kind (a task counted as R&D shows the feature icon), named by its tooltip. */
export const KindMarker = ({ glob }: { glob: Pick<GlobView, 'category' | 'type' | 'fix' | 'workKind'> }) => {
  const kind = kindOf(glob);
  const feature = kind === 'task' && workKindOf(glob) === 'rnd';
  const { icon: Icon, className, label } = feature ? FEATURE_ICON : KIND_ICON[kind];
  return (
    <Tip text={label}>
      <Icon className={cn('h-3.5 w-3.5 shrink-0', className)} aria-label={feature ? 'feature' : kind} role='img' />
    </Tip>
  );
};

/** Calendar days since the glob entered Doing (0 = today). */
const calendarDaysSince = (iso: string, now: Date) => {
  const start = new Date(iso);
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day(now) - day(start)) / 86_400_000);
};

/** Neutral, then amber at 2 calendar days in Doing without merging, then red. */
export const aging = (glob: GlobView, now = new Date()): 'neutral' | 'amber' | 'red' => {
  if (glob.list !== 'doing' || glob.doingSince == null) return 'neutral';
  const days = calendarDaysSince(glob.doingSince, now);
  return days >= 3 ? 'red' : days >= 2 ? 'amber' : 'neutral';
};

const AGING_STYLE = { neutral: 'bg-card', amber: 'bg-amber/15', red: 'bg-red/10' } as const;

/** Initials from an email's local part: john.bower@… → JB, alice@… → AL. */
const initials = (email: string): string => {
  const parts = (email.split('@')[0] ?? '').split(/[._-]+/).filter(Boolean);
  const [first = '', second = ''] = parts;
  return (second === '' ? first.slice(0, 2) : `${first.slice(0, 1)}${second.slice(0, 1)}`).toUpperCase();
};

/** The implementer, or the planner (dashed) while no person implements; slop as planner shows the robot head. */
/** True for slop itself, an agent or a bot account rather than a person. */
export const isMachineActor = (who: string): boolean =>
  !who.includes('@') || /(^|[._-])(bot|agent)([._-]|@|$)|\[bot\]/i.test(who);

const Avatar = ({ email, planner }: { email: string; planner: boolean }) =>
  isMachineActor(email) ? (
    <Tip text={`${planner ? 'Planner' : 'Implementer'}: ${email} (machine)`}>
      <span className='inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground'>
        <MachineIcon />
      </span>
    </Tip>
  ) : (
  <Tip text={`${planner ? 'Planner' : 'Implementer'}: ${email}`}>
  <span
    className={cn(
      'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border font-mono text-[9px] font-semibold',
      planner ? 'border-dashed border-muted-foreground text-muted-foreground' : 'bg-muted text-foreground',
    )}
  >
    {initials(email)}
  </span>
  </Tip>
  );

/**
 * A group's label: a curated sticker colour, the only shiny thing on the board. It is always just the tag, and a click does one
 * thing: with `to` it links there (the glob view links to the board filtered by the group); with only `onFilter` (the board's
 * cards) it filters the board to the group without opening the card; with neither it is plain.
 */
export const GroupChip = ({
  name,
  onFilter,
  to,
}: {
  name: string;
  onFilter?: (name: string) => void;
  to?: string;
}) => {
  const { hi, base, lo } = groupSticker(name);
  const colours: CSSProperties & Record<'--st-hi' | '--st-base' | '--st-lo', string> = {
    '--st-hi': hi,
    '--st-base': base,
    '--st-lo': lo,
  };
  const className = cn(TAG, 'sticker truncate');
  if (to !== undefined) {
    return (
      <Tip text={`Show only group: ${name}`}>
        <Link
          to={to}
          className={className}
          style={colours}
          data-testid='group-chip'
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {name}
        </Link>
      </Tip>
    );
  }
  if (onFilter === undefined) {
    return (
      <Tip text={`Group: ${name}`}>
        <span className={className} style={colours}>
          {name}
        </span>
      </Tip>
    );
  }
  return (
    <Tip text={`Show only group: ${name}`}>
      <button
        type='button'
        className={cn(className, 'cursor-pointer')}
        style={colours}
        aria-label={`Show only group ${name}`}
        data-testid='group-chip'
        onClick={(e) => {
          e.stopPropagation();
          onFilter(name);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {name}
      </button>
    </Tip>
  );
};

/**
 * The card's one status (see `presentGlob`): an icon and a few words on a single line that never wraps, truncated with the
 * full detail in its tooltip, anchored right. It shrinks before the ID does. It is text and an icon: a click at most opens the
 * glob view at a section, and it never runs an action or opens a link.
 */
const CornerStatusView = ({ status, onOpenSection }: { status: CornerStatus; onOpenSection: (target: GlobTarget) => void }) => {
  const click = status.click;
  const open = click === null ? undefined : () => onOpenSection(click);
  const needsHuman = status.kind === 'needs-human';
  return (
    <span className='inline-flex min-w-0 shrink justify-end' data-testid='card-status' data-kind={status.kind} data-icon={status.icon}>
      <Tip text={status.tip}>
        <ChipButton
          onOpen={open}
          className={cn('inline-flex min-w-0 items-center gap-1 text-right font-mono text-[11px]', status.tone)}
          testId={needsHuman ? 'escalation-chip' : 'position'}
          dataKind={status.kind}
          ariaLabel={needsHuman ? status.label : undefined}
        >
          <span className='truncate' data-testid='status-text'>
            {status.text}
          </span>
          <StatusIconView icon={status.icon} />
        </ChipButton>
      </Tip>
    </span>
  );
};

/**
 * A move made elsewhere, shown in the status slot for the tag's few seconds in place of the status (khaki, like the move's
 * flash). Keyed by the move, so a second move restarts the fade.
 */
const MoveTagView = ({ tag }: { tag: MoveTag }) => (
  <span
    key={tag.n}
    className='move-tag inline-flex min-w-0 shrink items-center justify-end gap-1 text-right font-mono text-[11px] text-[var(--remote)]'
    role='status'
    data-testid='card-status'
    data-kind='move-tag'
  >
    <span className='truncate' data-testid='status-text'>
      {tag.text}
    </span>
    {tag.icon !== undefined && <StatusIconView icon={tag.icon} />}
  </span>
);

/** A button on the card that stops its click and key from reaching the card, which opens the glob at the top. */
const CardButton = ({
  onOpen,
  className,
  testId,
  dataKind,
  ariaLabel,
  'aria-describedby': describedBy,
  children,
}: {
  onOpen: () => void;
  className: string;
  testId: string;
  dataKind?: string;
  ariaLabel?: string;
  /** Set by a wrapping `Tip`, which clones its child to link the tooltip text as the button's description. */
  'aria-describedby'?: string;
  children: ReactNode;
}) => (
  <button
    type='button'
    className={className}
    aria-label={ariaLabel}
    aria-describedby={describedBy}
    data-testid={testId}
    data-kind={dataKind}
    onClick={(e) => {
      e.stopPropagation();
      onOpen();
    }}
    onKeyDown={(e) => e.stopPropagation()}
  >
    {children}
  </button>
);

/** A chip that opens the glob view at its section. Without `onOpen` (a chip shown outside the board) it is plain text. */
export const ChipButton = ({
  onOpen,
  className,
  testId,
  dataKind,
  ariaLabel,
  'aria-describedby': describedBy,
  children,
}: {
  onOpen?: () => void;
  className: string;
  testId: string;
  dataKind?: string;
  /** The button's name, for chips whose visible words are hidden from screen readers. */
  ariaLabel?: string;
  'aria-describedby'?: string;
  children: ReactNode;
}) =>
  onOpen === undefined ? (
    <span className={cn('max-w-full truncate whitespace-nowrap', className)} data-testid={testId} data-kind={dataKind} aria-describedby={describedBy} {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel, role: 'img' })}>
      {children}
    </span>
  ) : (
    <CardButton
      onOpen={onOpen}
      className={cn('max-w-full truncate whitespace-nowrap', className, 'cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring')}
      testId={testId}
      dataKind={dataKind}
      ariaLabel={ariaLabel}
      aria-describedby={describedBy}
    >
      {children}
    </CardButton>
  );

export type { CardMove };

/** The card's one button, bottom left: Pick up, Start, Merge or Fix conflict. Merge and Fix conflict ask for a second click on the button itself. */
const MoveButton = ({
  move,
  hot,
  onPreview,
  onMove,
}: {
  move: CardMove;
  hot: boolean;
  onPreview: (move: CardMove | null) => void;
  onMove: (move: CardMove) => void;
}) => {
  const confirm = useConfirmClick();
  const inPlace = move.direction === 'none';
  const confirming = move.confirm && confirm.confirming;
  // The second click does what the button is for: a merge lands the PR, a conflict fix starts a run.
  const then = move.action === 'merge' ? 'merge' : 'start a conflict-fix run';
  const tip = confirming ? `${move.description}. Click again to ${then}` : move.description;
  return (
    <Tip text={tip}>
      <button
        type='button'
        className={cn(
          'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold shadow-[0_1px_0_var(--border)] active:translate-y-px active:shadow-none',
          confirming ? 'border-current bg-card text-required' : hot ? 'border-foreground bg-lcd text-lcd-foreground' : 'border-primary bg-primary text-primary-foreground hover:opacity-90',
        )}
        aria-label={tip}
        data-testid={`move-${move.action}`}
        data-confirming={confirming ? 'true' : undefined}
        // An in-place move has no ghost piece to preview.
        onMouseEnter={() => !inPlace && onPreview(move)}
        onMouseLeave={() => !inPlace && onPreview(null)}
        onFocus={() => !inPlace && onPreview(move)}
        onBlur={() => {
          confirm.cancel();
          if (!inPlace) onPreview(null);
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (!confirm.click(move.confirm)) return;
          onMove(move);
        }}
        onKeyDown={confirm.onKeyDown}
      >
        <ActorIcon actor={move.icon} className='h-3 w-3' decorative />
        {confirming ? `Confirm ${move.label.toLowerCase()}` : move.label}
      </button>
    </Tip>
  );
};

/** One ATF run in words, for tooltips and the glob view. */
export const atfLine = (run: AtfRun): string => {
  const where = run.scope === 'branch' ? `Branch${run.environment === null ? '' : ` (${run.environment})`}` : run.environment ?? '';
  const counts = `${run.passed} passed, ${run.failed} failed${run.skipped > 0 ? `, ${run.skipped} skipped` : ''}`;
  const own = run.plannedSpecs === undefined ? '' : ` · this glob's planned specs: ${plannedSpecsText(run.plannedSpecs)}`;
  // Only set when the board has several runners, so a one-runner board reads as before.
  const runner = run.runnerName === undefined ? '' : ` · runner: ${run.runnerName}`;
  return `${where} at ${run.sha.slice(0, 7)}: ${counts}${runner}${run.stale === true ? ' (an older commit than the PR head)' : ''}${own}`;
};

/** The glob's own planned specs in one run, in words: "2 passed, 1 failed, 1 missing, 1 not reported". */
export const plannedSpecsText = (p: NonNullable<AtfRun['plannedSpecs']>): string =>
  [
    `${p.passed} passed`,
    ...(p.failed > 0 ? [`${p.failed} failed`] : []),
    ...(p.skipped > 0 ? [`${p.skipped} skipped`] : []),
    ...(p.missing > 0 ? [`${p.missing} missing`] : []),
    ...(p.unreported > 0 ? [`${p.unreported} not reported`] : []),
  ].join(', ');

/**
 * The "Arm system" label: a person has a step at release (an open rollout step, or one due after the merge), named by its stage. Rocket and text in the
 * primary action's colour (not red, which means broken), normal weight. `onOpen` opens the glob at its Human steps; without it the
 * label is plain.
 */
export const ArmSystemLabel = ({ label, onOpen }: { label: ArmLabel; onOpen?: () => void }) => (
  <Tip text={label.tip}>
    <ChipButton onOpen={onOpen} className='inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[11px] text-primary' testId='arm-system-label'>
      <Rocket className='h-3 w-3 shrink-0' aria-hidden />
      {label.text}
    </ChipButton>
  </Tip>
);

const bumpStyle = (side: 'left' | 'right'): CSSProperties & Record<'--bump', string> => ({
  '--bump': side === 'left' ? '-3px' : '3px',
});

export const GlobCard = ({
  glob,
  onOpen,
  onOpenSection,
  onReviewLabel,
  previewing,
  onPreview,
  onMove,
  repo,
  onArrow,
  lock,
  bump,
  tag,
  viewer,
  waitingOnThis = 0,
  base,
  pending,
  onFilterGroup,
}: {
  glob: GlobView;
  onOpen: () => void;
  /** Filters the board to a group (the card's group tag); without it the tag is plain. */
  onFilterGroup?: (name: string) => void;
  /** Opens the glob at the section the status points to; `onOpen` opens it at the top. */
  onOpenSection: (target: GlobTarget) => void;
  /** Approves or re-opens a sign-off label from the card's popover; absent on a read-only card, whose popover then only links to the review. */
  onReviewLabel?: ReviewLabel;
  /** The move whose ghost piece is showing, if it is this card's. */
  previewing: Action | null;
  onPreview: (move: CardMove | null) => void;
  /** Runs the card's primary button (after its confirming click, for Merge and Fix conflict). */
  onMove: (move: CardMove) => void;
  /** The board's GitHub repo. */
  repo?: string;
  /** ← / → on the focused card: preview its move that way (or bump the wall). */
  onArrow: (direction: 'left' | 'right') => void;
  /** The flash as the card locks into its new list: yours, or a move made elsewhere. */
  lock?: 'local' | 'remote';
  /** Nudges toward a side with no move. */
  bump?: 'left' | 'right';
  /** Who moved it, briefly, when the move was made elsewhere. */
  tag?: MoveTag;
  /** Who is looking: Your turn shows the steps that are theirs. */
  viewer?: HumanStepViewer;
  /** How many globs in Planning wait for this one to merge. */
  waitingOnThis?: number;
  /** The board's base branch, for "merging from <base>". */
  base?: string;
  /** A click this client sent that the glob does not show yet: the card shows it in progress at once. */
  pending?: PendingAction | null;
}) => {
  // A person implementing shows; otherwise (unassigned, or the machine implementing) the planner. Slop-created globs show the robot head.
  const person = glob.implementer ?? glob.planner;
  const failed = glob.status === 'failed' || glob.failure !== null;
  const age = aging(glob);
  // Everything the card says comes from the one presentation: the status top right, the single button bottom left.
  const present = presentOf(glob, { ...(viewer === undefined ? {} : { viewer }), ...(base === undefined ? {} : { base }), repo: repo ?? null, waitingOnThis, ...(pending === undefined ? {} : { pending }) });
  const { status } = present;
  const move = present.cardPrimary === null ? null : cardMoveOf(present.cardPrimary);
  const preview = move !== null && move.action === previewing ? move : undefined;
  const human = isHumanCategory(glob.category);
  const arming = human ? null : armLabel(glob);

  return (
    <div
      role='button'
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Keys from inside the card (its button) are theirs, not the card's.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onArrow(e.key === 'ArrowLeft' ? 'left' : 'right');
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (preview === undefined) onOpen();
          else onMove(preview);
        } else if (e.key === 'Escape' && preview !== undefined) {
          onPreview(null);
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onPreview(null);
      }}
      className={cn(
        'card-edge relative flex cursor-pointer flex-col gap-1.5 rounded-md border px-3 py-2.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        AGING_STYLE[age],
        failed && 'border-red-soft',
        lock === 'local' && 'lock-local',
        lock === 'remote' && 'lock-remote',
        bump !== undefined && 'wall-bump',
      )}
      style={bump === undefined ? undefined : bumpStyle(bump)}
      aria-busy={present.pending !== null}
      data-glob-id={glob.id}
      data-testid={`card-${glob.id}`}
    >
      <div className='flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground' data-testid='card-header'>
        {/* The ID never truncates: the status text gives way first, the fix marker never moves. */}
        <span className='inline-flex shrink-0 gap-[3px] whitespace-nowrap' data-testid='card-id'>
          <span>{glob.id}</span>
          <DotSeparator />
          <span data-testid='card-type'>
            {modeOf(glob)}
            {glob.type === 'super' && glob.list === 'planning' ? ' · pairing' : ''}
          </span>
        </span>
        <span className='inline-flex min-w-0 items-center justify-end gap-1.5' data-testid='card-corner'>
          {tag !== undefined && (
            <>
              <MoveTagView tag={tag} />
              <DotSeparator testId='card-corner-separator' />
            </>
          )}
          {tag === undefined && status !== null && (
            <>
              <CornerStatusView status={status} onOpenSection={onOpenSection} />
              <DotSeparator testId='card-corner-separator' />
            </>
          )}
          <KindMarker glob={glob} />
        </span>
      </div>
      <div className='leading-snug font-medium break-words' data-testid='card-title'>
        {stripMarkdown(glob.title)}
      </div>
      {/* One wrapping row: primary button, group tag, then the Arm system / dot / avatar group pushed right. It shares a line while it fits and
          wraps under as a unit (still right-aligned) when it doesn't, so Arm system never splits from the avatar. */}
      <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5' data-testid='card-bottom'>
        {move !== null && (
          <div className='flex min-w-0 flex-wrap items-center gap-1.5' data-testid='card-actions'>
            <MoveButton move={move} hot={move.action === previewing} onPreview={onPreview} onMove={onMove} />
          </div>
        )}
        {(glob.group !== null || !human) && (
          <div className='flex min-w-0 flex-wrap items-center gap-1.5 empty:hidden' data-testid='card-chips'>
            {glob.group !== null && <GroupChip name={glob.group} onFilter={onFilterGroup} />}
            {!human && (
              <LabelPopover glob={glob} onReview={onReviewLabel} onOpenReview={(label) => onOpenSection(cardTargets.label(label))} />
            )}
          </div>
        )}
        <div className='ml-auto flex shrink-0 items-center gap-1.5' data-testid='card-trailing'>
          {arming !== null && (
            <>
              <ArmSystemLabel label={arming} onOpen={() => onOpenSection(cardTargets.humanSteps())} />
              <DotSeparator testId='card-arm-separator' />
            </>
          )}
          <Avatar email={person} planner={glob.implementer === null} />
        </div>
      </div>
    </div>
  );
};
