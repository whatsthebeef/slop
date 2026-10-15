import { decisionOf, isHumanCategory, modeOf } from '@slop/core';
import type { Action, DeployIndicator, EnvironmentIndicator, HumanStepViewer } from '@slop/core';
import { Bug, ListChecks, Loader2, Rocket, Scale } from 'lucide-react';
import type { ComponentType } from 'react';
import { ActorIcon, HumanIcon, MachineIcon, PersonRunning } from '@/components/actor-icons';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import type { AtfRun, GlobView, ListedHumanStep } from '@/lib/api';
import type { MoveTag } from '@/lib/board-motion';
import { kindOf } from '@/lib/board-filters';
import type { Kind } from '@/lib/board-filters';
import { cornerStatus, hasBlocker } from '@/lib/card-rows';
import type { CornerStatus } from '@/lib/card-rows';
import { needsRelease } from '@/lib/human-steps';
import { StatusIconView } from '@/components/status-icon';
import { cn, groupSticker } from '@/lib/utils';
import { mainAction } from '@/lib/main-action';
import { workingLabel } from '@/lib/card-pending';
import { clickTip, prUrl, tipLines, turnStep } from '@/lib/chip-actions';
import type { ChipClick } from '@/lib/chip-actions';
import { useConfirmClick } from '@/lib/use-confirm-click';
import { cardTargets } from '@/lib/card-targets';
import type { GlobTarget } from '@/lib/glob-section';
import { stripMarkdown } from '@/lib/markdown-text';
import { Tip } from './ui/tip';
import { LabelPopover } from './labels';
import type { ReviewLabel } from './labels';

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

/** The corner marker of every glob: the icon of its kind, named by its tooltip. */
export const KindMarker = ({ glob }: { glob: Pick<GlobView, 'category' | 'type' | 'fix'> }) => {
  const kind = kindOf(glob);
  const { icon: Icon, className, label } = KIND_ICON[kind];
  return (
    <Tip text={label}>
      <Icon className={cn('h-3.5 w-3.5 shrink-0', className)} aria-label={kind} role='img' />
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
  const className = 'sticker max-w-full truncate whitespace-nowrap rounded-sm px-1.5 font-mono text-[10px] font-semibold';
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
 * The card's one status (see `cornerStatus`): an icon and a few words on a single line that never wraps, truncated with the
 * full detail in its tooltip, anchored right. It shrinks before the ID does.
 */
const CornerStatusView = ({
  status,
  pending,
  onAct,
  onOpenSection,
}: {
  status: CornerStatus;
  pending?: Action;
  onAct?: (action: Action) => void;
  onOpenSection: (target: GlobTarget) => void;
}) => {
  const click = status.click;
  const confirm = useConfirmClick();
  const confirming = confirm.confirming;
  // Merge and Done are run from here: a chip button, with Merge asking for a second click (Esc, blur or the timeout reverts it).
  if (status.kind === 'ready' && click?.kind === 'act') {
    const busy = pending !== undefined;
    const label = busy ? workingLabel(pending) : confirming ? 'confirm merge' : status.text;
    const tip = tipLines([...status.tip.split('\n').filter((line) => line !== clickTip(click)), clickTip(click, confirming)]);
    return (
      <span className='inline-flex min-w-0 shrink justify-end' data-testid='card-status' data-kind={status.kind} data-icon={status.icon}>
        <Tip text={tip}>
          <button
            type='button'
            className={cn(
              'inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-sm border border-current px-1.5 text-right font-mono text-[11px] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60',
              confirming ? 'text-required' : status.tone,
            )}
            disabled={busy}
            data-testid='position'
            data-kind={status.kind}
            data-confirming={confirming ? 'true' : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (busy) return;
              if (!confirm.click(turnStep(click, confirming) === 'confirm')) return;
              (onAct ?? (() => undefined))(click.action);
            }}
            onKeyDown={confirm.onKeyDown}
            onBlur={confirm.cancel}
          >
            <span className='truncate' data-testid='status-text'>
              {label}
            </span>
            {busy ? <Loader2 className='h-3 w-3 shrink-0 animate-spin' aria-hidden /> : <StatusIconView icon={status.icon} />}
          </button>
        </Tip>
      </span>
    );
  }
  const open = click === null ? undefined : () => runChip(click, onAct ?? (() => undefined), onOpenSection);
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

import type { CardMove } from '@/lib/card-moves';
export type { CardMove };

const MoveButton = ({
  move,
  hot,
  primary,
  disabled,
  onPreview,
  onMove,
}: {
  move: CardMove;
  hot: boolean;
  primary: boolean;
  disabled: boolean;
  onPreview: (move: CardMove | null) => void;
  onMove: (move: CardMove) => void;
}) => {
  const confirm = useConfirmClick();
  const inPlace = move.direction === 'none';
  const confirming = move.confirm && confirm.confirming;
  const tip = confirming ? `${move.description}. Click again to start a conflict-fix run` : move.description;
  return (
  <Tip text={tip}>
  <button
    type='button'
    className={cn(
      'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold shadow-[0_1px_0_var(--border)] active:translate-y-px active:shadow-none',
      confirming ? 'border-current bg-card text-required' : hot ? 'border-foreground bg-lcd text-lcd-foreground' : primary ? 'border-primary bg-primary text-primary-foreground hover:opacity-90' : 'border-foreground/70 bg-card text-foreground hover:bg-muted',
      'disabled:pointer-events-none disabled:opacity-50',
    )}
    aria-label={tip}
    disabled={disabled}
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

/** The glob's deploy state on its card: deploying, live, failed, or replaced by another glob. */
export const DeployChip = ({ deploy, onOpen }: { deploy: DeployIndicator; onOpen?: () => void }) => {
  const env = deploy.environment;
  const [text, tip, tone] =
    deploy.state === 'deploying'
      ? [
          deploy.waiting ? `${env}: queued` : `${env}: deploying`,
          deploy.waiting ? `Waiting for the deploy running in ${env}` : `Deploying to ${env}`,
          'text-muted-foreground',
        ]
      : deploy.state === 'live'
        ? [`${env}: live`, `Live in ${env} at ${deploy.sha.slice(0, 7)}`, 'text-signal-strong']
        : deploy.state === 'failed'
          ? [`${env}: deploy failed`, `Deploy to ${env} failed: ${deploy.error ?? 'no reason given'}`, 'text-red']
          : [`${env}: replaced`, `${deploy.by} has been deployed to ${env} since`, 'text-muted-foreground'];
  return (
    <Tip text={onOpen === undefined ? tip : `${tip}. Opens the deploys`}>
      <ChipButton onOpen={onOpen} className={cn('inline-flex items-center gap-1 font-mono text-[11px]', tone)} testId='deploy-chip'>
        {deploy.state === 'deploying' && !deploy.waiting && <Loader2 className='h-3 w-3 animate-spin' />}
        {text}
      </ChipButton>
    </Tip>
  );
};

const since = (iso: string | null) => (iso === null ? '' : ` since ${new Date(iso).toLocaleString()}`);

/**
 * The release and integration environments the glob is in (their deployed commit contains its merge), one chip each.
 * Production before sign-off is allowed but flagged.
 */
export const EnvironmentChips = ({ environments }: { environments: readonly EnvironmentIndicator[] }) => (
  <>
    {environments.map((env) => {
      const warned = env.warning === 'before_sign_off';
      const tip = `${warned ? 'Deployed to production before sign-off. ' : ''}In ${env.environment} (${env.production ? 'production' : env.role}) at ${env.sha.slice(0, 7)}${since(env.since)}`;
      return (
        <Tip key={env.environment} text={tip}>
          <span
            className={cn('whitespace-nowrap font-mono text-[11px]', warned ? 'text-required' : 'text-signal-strong')}
            data-testid='environment-chip'
            data-warning={env.warning}
          >
            {env.environment} ✓
          </span>
        </Tip>
      );
    })}
  </>
);

/** One ATF run in words, for tooltips and the glob view. */
export const atfLine = (run: AtfRun): string => {
  const where = run.scope === 'branch' ? `Branch${run.environment === null ? '' : ` (${run.environment})`}` : run.environment ?? '';
  const counts = `${run.passed} passed, ${run.failed} failed${run.skipped > 0 ? `, ${run.skipped} skipped` : ''}`;
  const own = run.plannedSpecs === undefined ? '' : ` · this glob's planned specs: ${plannedSpecsText(run.plannedSpecs)}`;
  return `${where} at ${run.sha.slice(0, 7)}: ${counts}${run.stale === true ? ' (an older commit than the PR head)' : ''}${own}`;
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

/** Whether a run is a failure for this glob: its own planned specs when the run reported them, else any failing test. */
const failsForGlob = (run: AtfRun): boolean => (run.plannedSpecs === undefined ? run.failing : run.plannedSpecs.failed > 0);

/** The chip's words for a run: the glob's own specs when the run reported them ("ATF 2/3 specs ✓"), else the run's counts. */
const atfChipText = (run: AtfRun): string => {
  const p = run.plannedSpecs;
  if (p === undefined) return run.failing ? `ATF ${run.failed} failed` : `ATF ${run.passed}✓`;
  if (p.failed > 0) return `ATF ${p.failed} of ${p.total} specs failed`;
  return `ATF ${p.passed}/${p.total} specs ✓${p.missing > 0 ? ` ${p.missing} missing` : ''}`;
};

/**
 * The glob's ATF results in one chip: red when any current run has a failing test (a flag only; it never blocks),
 * muted when the only run tested an older commit. It links to the report of the run it summarises.
 */
export const AtfChip = ({ runs }: { runs: readonly AtfRun[] }) => {
  const current = runs.filter((r) => r.stale !== true);
  const shown = current.find(failsForGlob) ?? current[0] ?? runs[0];
  if (shown === undefined) return null;
  const failing = current.some(failsForGlob);
  // The text always says what the run found; a stale run is only muted, never shown as passing. With a test plan the
  // chip counts the glob's own planned specs, so another glob's failing spec in the same run doesn't turn it red.
  const text = atfChipText(shown);
  const missing = shown.plannedSpecs !== undefined && shown.plannedSpecs.missing > 0;
  const tone = failing ? 'text-red' : missing ? 'text-required' : current.length > 0 ? 'text-signal-strong' : 'text-muted-foreground';
  const tip = runs.map((r) => `${atfLine(r)} · ${new Date(r.at).toLocaleString()}`).join('\n');
  const chip = (
    <span className={cn('whitespace-nowrap font-mono text-[11px]', tone)} data-testid='atf-chip' data-failing={failing}>
      {text}
    </span>
  );
  return (
    <Tip text={tip}>
      {shown.url === null ? (
        chip
      ) : (
        <a
          href={shown.url}
          target='_blank'
          rel='noreferrer'
          className='hover:underline'
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {chip}
        </a>
      )}
    </Tip>
  );
};

/**
 * The "Arm system" label: a person has a step at release (an open rollout step, or one due after the merge). Rocket and text in the
 * primary action's colour (not red, which means broken), normal weight. `onOpen` opens the glob at its Human steps; without it the
 * label is plain.
 */
export const ArmSystemLabel = ({ step, onOpen }: { step: Pick<ListedHumanStep, 'title'>; onOpen?: () => void }) => (
  <Tip text={`A person has a step at release: ${step.title}`}>
    <ChipButton onOpen={onOpen} className='inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[11px] text-primary' testId='arm-system-label'>
      <Rocket className='h-3 w-3 shrink-0' aria-hidden />
      Arm system
    </ChipButton>
  </Tip>
);

/** An action glob's chip: who is meant to do it, or how it ended. Nothing for other globs. */
export const ActionChips = ({ glob }: { glob: GlobView }) => {
  const action = glob.category === 'action' && glob.attributes !== undefined && 'assignee' in glob.attributes ? glob.attributes : null;
  if (action === null) return null;
  const { outcome } = action;
  const text = outcome === null ? (action.assignee ?? 'anyone') : outcome.kind === 'done' ? 'done' : 'dismissed';
  const tip =
    outcome === null
      ? action.assignee === null
        ? 'Anyone on the board can do this and mark it done'
        : `${action.assignee} is meant to do this`
      : `${outcome.kind === 'done' ? 'Done' : 'Dismissed'} by ${outcome.by}${outcome.note === undefined && outcome.reason === undefined ? '' : `: ${outcome.note ?? outcome.reason ?? ''}`}`;
  return (
    <Tip text={tip}>
      <span className='inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground' data-testid='action-chip'>
        <HumanIcon decorative />
        {text}
      </span>
    </Tip>
  );
};

const bumpStyle = (side: 'left' | 'right'): CSSProperties & Record<'--bump', string> => ({
  '--bump': side === 'left' ? '-3px' : '3px',
});

/** Runs a chip's click: an action, the glob view at a section, or a page in a new tab. */
const runChip = (click: ChipClick, onAct: (action: Action) => void, onOpenSection: (target: GlobTarget) => void) => {
  if (click.kind === 'act') onAct(click.action);
  else if (click.kind === 'section') onOpenSection(click.target);
  else window.open(click.url, '_blank', 'noopener,noreferrer');
};

export const GlobCard = ({
  glob,
  onOpen,
  onOpenSection,
  onReviewLabel,
  moves,
  pending,
  previewing,
  onPreview,
  onMove,
  onAct,
  repo,
  onArrow,
  lock,
  bump,
  tag,
  deploy,
  environments,
  atf,
  viewer,
  waitingOnThis = 0,
  onFilterGroup,
}: {
  glob: GlobView;
  onOpen: () => void;
  /** Filters the board to a group (the card's group tag); without it the tag is plain. */
  onFilterGroup?: (name: string) => void;
  /** Opens the glob at the section (and artifact or label) a chip or icon points to; `onOpen` opens it at the top. */
  onOpenSection: (target: GlobTarget) => void;
  /** Absent on a read-only card (the signed-off list): its label chips then offer no approve or re-open. */
  onReviewLabel?: ReviewLabel;
  /** Only the moves this glob can make; none means no buttons at all. */
  moves: readonly CardMove[];
  /** The move in flight on this glob, if any: the card shows it working and takes no other move. */
  pending?: Action;
  /** The move whose ghost piece is showing, if it is this card's. */
  previewing: Action | null;
  onPreview: (move: CardMove | null) => void;
  onMove: (move: CardMove) => void;
  /** Runs an action from the corner status (Your turn: Merge, Done); the board's own action path, with its pending state. */
  onAct?: (action: Action) => void;
  /** The board's GitHub repo, for chips that open the PR's checks. */
  repo?: string;
  /** ← / → on the focused card: cycle its moves that way (or bump the wall). */
  onArrow: (direction: 'left' | 'right') => void;
  /** The flash as the card locks into its new list: yours, or a move made elsewhere. */
  lock?: 'local' | 'remote';
  /** Nudges toward a side with no move. */
  bump?: 'left' | 'right';
  /** Who moved it, briefly, when the move was made elsewhere. */
  tag?: MoveTag;
  deploy?: DeployIndicator;
  /** The release and integration environments it is in. */
  environments?: readonly EnvironmentIndicator[];
  /** Its ATF results (a flag only). */
  atf?: readonly AtfRun[];
  /** Who is looking: Your turn shows the steps that are theirs. */
  viewer?: HumanStepViewer;
  /** How many globs in Planning wait for this one to merge. */
  waitingOnThis?: number;
}) => {
  // A person implementing shows; otherwise (unassigned, or the machine implementing) the planner. Slop-created globs show the robot head.
  const person = glob.implementer ?? glob.planner;
  const failed = glob.status === 'failed' || glob.failure !== null;
  const age = aging(glob);
  const now = new Date().toISOString();
  const preview = moves.find((m) => m.action === previewing);
  // Decision globs have their own look (an accent edge, the outcome in the corner) and no labels, branch or routine status; neither do actions.
  const decision = decisionOf(glob) !== null;
  const human = isHumanCategory(glob.category);
  const status = cornerStatus(glob, now, viewer, repo, waitingOnThis);
  const blocked = hasBlocker(glob, now, viewer);
  const armStep = human ? null : needsRelease(glob.humanSteps ?? []);
  // The board hands over the glob's card moves (the one common action); a blocker hides them all.
  // A blocker hides the moves, but not one that runs in place: Fix conflict is the answer to a conflict, which is itself a blocker.
  const shown = blocked ? moves.filter((m) => m.direction === 'none') : moves;

  return (
    <div
      role='button'
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Keys from inside the card (label switches, their popover, buttons) are theirs, not the card's.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onArrow(e.key === 'ArrowLeft' ? 'left' : 'right');
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (preview === undefined) onOpen();
          else if (pending === undefined) onMove(preview);
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
      aria-busy={pending !== undefined}
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
              <CornerStatusView status={status} pending={pending} onAct={onAct} onOpenSection={onOpenSection} />
              <DotSeparator testId='card-corner-separator' />
            </>
          )}
          <KindMarker glob={glob} />
        </span>
      </div>
      <div className='leading-snug font-medium break-words' data-testid='card-title'>
        {stripMarkdown(glob.title)}
      </div>
      <div className='flex min-w-0 items-end justify-between gap-2' data-testid='card-bottom'>
        <div className='flex min-w-0 flex-1 flex-col gap-1.5 empty:hidden'>
          <div className='flex min-w-0 flex-wrap items-center gap-1.5 empty:hidden' data-testid='card-chips'>
            {glob.group !== null && <GroupChip name={glob.group} onFilter={onFilterGroup} />}
            {decision ? null : human ? (
              <ActionChips glob={glob} />
            ) : (
              <LabelPopover glob={glob} onReview={onReviewLabel} onOpenReview={(label) => onOpenSection(cardTargets.label(label))} />
            )}
            {glob.clash != null && (
              <Tip text={`${glob.clash.with} also changes some of the same files; whichever merges second will conflict. Opens the conflict`}>
                <ChipButton onOpen={() => onOpenSection(cardTargets.conflict())} className='font-mono text-[11px] text-required' testId='clash-chip'>
                  clashes with {glob.clash.with}
                </ChipButton>
              </Tip>
            )}
            {deploy !== undefined && <DeployChip deploy={deploy} onOpen={() => onOpenSection(cardTargets.deploys())} />}
            {environments !== undefined && <EnvironmentChips environments={environments} />}
            {atf !== undefined && <AtfChip runs={atf} />}
            {age !== 'neutral' && glob.pr?.state === 'draft' && (
              <Tip text='Two or more days in Doing and the PR is still a draft'>
                <ChipButton
                  onOpen={prUrl(repo, glob) === null ? undefined : () => window.open(prUrl(repo, glob) ?? '', '_blank', 'noopener,noreferrer')}
                  className='font-mono text-[11px] text-muted-foreground'
                  testId='draft-chip'
                >
                  PR still draft
                </ChipButton>
              </Tip>
            )}
          </div>
          {(pending !== undefined || shown.length > 0) && (
            <div className='flex min-w-0 flex-wrap items-center gap-1.5' data-testid='card-actions'>
              {pending !== undefined && (
                <span className='inline-flex items-center gap-1 whitespace-nowrap font-mono text-[10px] text-muted-foreground' role='status' data-testid='card-pending'>
                  <Loader2 className='size-3 animate-spin' aria-hidden />
                  {workingLabel(pending)}
                </span>
              )}
              {shown.map((move, _i, all) => (
                <MoveButton
                  key={move.action}
                  move={move}
                  hot={move.action === previewing}
                  disabled={pending !== undefined}
                  primary={move.direction === 'none' || mainAction(all.map((m) => m.action), glob, human) === move.action}
                  onPreview={onPreview}
                  onMove={onMove}
                />
              ))}
            </div>
          )}
        </div>
        <div className='flex shrink-0 items-center gap-1.5'>
          {armStep !== null && (
            <>
              <ArmSystemLabel step={armStep} onOpen={() => onOpenSection(cardTargets.humanSteps())} />
              <DotSeparator testId='card-arm-separator' />
            </>
          )}
          <Avatar email={person} planner={glob.implementer === null} />
        </div>
      </div>
    </div>
  );
};
