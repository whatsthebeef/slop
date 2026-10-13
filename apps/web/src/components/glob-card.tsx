import { decisionOf, dueText, findingsLabel, reviewOutdated, scopeLabel, upcomingSteps } from '@slop/core';
import type { Action, Category, DeployIndicator, EnvironmentIndicator, HumanStepViewer } from '@slop/core';
import { AlertTriangle, Bug, GitBranch, Hourglass, ListChecks, Loader2, Pencil, Scale, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ActorIcon, HumanIcon } from '@/components/actor-icons';
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import type { AtfRun, GlobView } from '@/lib/api';
import type { MoveTag } from '@/lib/board-motion';
import type { Position } from '@/lib/position';
import { positionOf } from '@/lib/position';
import { cardStatus, cornerMarker, hasBlocker, turnButton } from '@/lib/card-rows';
import type { CornerMarker } from '@/lib/card-rows';
import { useTitleEdit } from '@/lib/title-edit';
import type { EditFailure } from '@slop/core';
import type { GlobChanges } from '@/lib/api';
import { cn, groupSticker } from '@/lib/utils';
import { ARTIFACT_META, CARD_ARTIFACT_KINDS } from './artifacts';
import { OUTCOME_TEXT } from './decision-section';
import { mainAction } from '@/lib/main-action';
import { workingLabel } from '@/lib/card-pending';
import { splitChip } from '@/lib/split-chip';
import { CONFIRM_MS, clickTip, prUrl, turnStep } from '@/lib/chip-actions';
import type { ChipClick } from '@/lib/chip-actions';
import { cardTargets } from '@/lib/card-targets';
import type { GlobTarget } from '@/lib/glob-section';
import { Tip } from './ui/tip';
import { LabelPopover } from './labels';
import type { ReviewLabel } from './labels';
import { boardGlobHref } from '@/lib/glob-section';

/** The glob's category as a small icon in the card's corner. */
export const CATEGORY_ICON: Record<Category, { icon: LucideIcon; className: string }> = {
  bug: { icon: Bug, className: 'text-red' },
  feature: { icon: Sparkles, className: 'text-muted-foreground' },
  task: { icon: ListChecks, className: 'text-muted-foreground' },
  decision: { icon: Scale, className: 'text-muted-foreground' },
};

const CategoryIcon = ({ category }: { category: Category }) => {
  const { icon: Icon, className } = CATEGORY_ICON[category];
  return (
    <Tip text={`Category: ${category}`}>
      <Icon className={cn('h-3.5 w-3.5 shrink-0', className)} aria-label={category} role='img' />
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

/** The implementer, or the planner (dashed) while nobody has picked the glob up. */
const Avatar = ({ email, planner }: { email: string; planner: boolean }) => (
  <Tip text={`${planner ? 'Planner (not picked up yet)' : 'Implementer'}: ${email}`}>
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

/** A group's label: a curated sticker colour, the only shiny thing on the board. */
export const GroupChip = ({ name }: { name: string }) => {
  const { hi, base, lo } = groupSticker(name);
  const colours: CSSProperties & Record<'--st-hi' | '--st-base' | '--st-lo', string> = {
    '--st-hi': hi,
    '--st-base': base,
    '--st-lo': lo,
  };
  return (
    <Tip text={`Group: ${name}`}>
      <span className='sticker max-w-full truncate whitespace-nowrap rounded-sm px-1.5 font-mono text-[10px] font-semibold' style={colours}>
        {name}
      </span>
    </Tip>
  );
};

/**
 * The card's one corner marker (see `cornerMarker`): a single line that never wraps, truncated with the full text in its
 * tooltip, anchored right. Stalled hides standby; the tooltip says it instead.
 */
const CornerMarkerView = ({
  marker,
  position,
  onAct,
  onOpenSection,
}: {
  marker: CornerMarker;
  position: Position | null;
  onAct?: (action: Action) => void;
  onOpenSection: (target: GlobTarget) => void;
}) => {
  const click = marker.click;
  const open = click === null ? undefined : () => runChip(click, onAct ?? (() => undefined), onOpenSection);
  const needsHuman = marker.kind === 'needs-human';
  return (
    <span className='inline-flex min-w-0 max-w-[45%] justify-end' data-testid='corner-marker' data-kind={marker.kind}>
      <Tip text={open === undefined || click === null || needsHuman ? marker.tip : `${marker.tip}\n${clickTip(click)}`}>
        <ChipButton
          onOpen={open}
          className={cn('inline-flex min-w-0 items-center gap-1 text-right font-mono text-[11px]', marker.tone)}
          testId={needsHuman ? 'escalation-chip' : 'position'}
          dataKind={marker.kind}
          ariaLabel={needsHuman ? 'Needs a person' : undefined}
        >
          {needsHuman ? (
            // The visible words are hidden: the button's label names it and the Tip's description gives the reason.
            <span aria-hidden className='inline-flex items-center gap-1'>
              needs a <HumanIcon className='h-3 w-3' decorative />
            </span>
          ) : (
            <>
              {marker.kind === 'standby' ? (
                <ActorIcon actor='machine' className='h-3 w-3 shrink-0' decorative />
              ) : position === null ? null : (
                <PositionIcon position={position} />
              )}
              <span className='truncate'>{marker.text}</span>
            </>
          )}
        </ChipButton>
      </Tip>
    </span>
  );
};

const PositionIcon = ({ position }: { position: Position }) => {
  if (position.spinning) return <Loader2 className='h-3 w-3 shrink-0 animate-spin' aria-hidden />;
  if (position.holder === 'waiting') return <Hourglass className='h-3 w-3 shrink-0' aria-hidden />;
  if (position.holder === 'stalled') return <AlertTriangle className='h-3 w-3 shrink-0' aria-hidden />;
  return <ActorIcon actor={position.holder === 'human' ? 'human' : 'machine'} className='h-3 w-3 shrink-0' decorative />;
};

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
    <span className={cn('max-w-full truncate whitespace-nowrap', className)} data-testid={testId} data-kind={dataKind} aria-describedby={describedBy}>
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

/**
 * Small icons for the artifacts the glob has; each opens the glob view on that artifact. An independent review's finding
 * count is its own button beside the icon and opens the findings.
 */
const ArtifactIcons = ({ glob, onOpen }: { glob: GlobView; onOpen: (target: GlobTarget) => void }) => {
  const present = CARD_ARTIFACT_KINDS.flatMap((kind) => {
    const artifact = glob.artifacts?.find((a) => a.kind === kind);
    return artifact === undefined ? [] : [artifact];
  });
  if (present.length === 0) return null;
  return (
    <span className='inline-flex items-center gap-0.5'>
      {present.map((a) => {
        const { title, icon: Icon } = ARTIFACT_META[a.kind];
        // An independent review shows its finding count, and says so when a later push left it behind.
        const status = a.review === undefined ? null : `${findingsLabel(a.review.findings)}${reviewOutdated(a.review, glob.pr?.headSha ?? null) ? ' (outdated)' : ''}`;
        return (
          <span key={a.kind} className='inline-flex items-center'>
            <Tip text={`${title} v${a.version}${a.commitSha === null ? '' : ` at ${a.commitSha.slice(0, 7)}`}: opens it in the artifacts`}>
              <CardButton
                onOpen={() => onOpen(cardTargets.artifact(a.kind))}
                className='inline-flex items-center rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground'
                ariaLabel={title}
                testId={`artifact-icon-${a.kind}`}
              >
                <Icon className='h-3.5 w-3.5' />
              </CardButton>
            </Tip>
            {status !== null && (
              <Tip text={`${title}: ${status}. Opens the findings`}>
                <CardButton
                  onOpen={() => onOpen(cardTargets.findings())}
                  className='rounded-sm px-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground'
                  testId='review-status'
                >
                  {status}
                </CardButton>
              </Tip>
            )}
          </span>
        );
      })}
    </span>
  );
};

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
}) => (
  <Tip text={move.description}>
  <button
    type='button'
    className={cn(
      'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold shadow-[0_1px_0_var(--border)] active:translate-y-px active:shadow-none',
      hot ? 'border-foreground bg-lcd text-lcd-foreground' : primary ? 'border-primary bg-primary text-primary-foreground hover:opacity-90' : 'border-foreground/70 bg-card text-foreground hover:bg-muted',
      'disabled:pointer-events-none disabled:opacity-50',
    )}
    aria-label={move.description}
    disabled={disabled}
    data-testid={`move-${move.action}`}
    onMouseEnter={() => onPreview(move)}
    onMouseLeave={() => onPreview(null)}
    onFocus={() => onPreview(move)}
    onBlur={() => onPreview(null)}
    onClick={(e) => {
      e.stopPropagation();
      onMove(move);
    }}
    onKeyDown={(e) => e.stopPropagation()}
  >
    <ActorIcon actor={move.icon} className='h-3 w-3' decorative />
    {move.label}
  </button>
  </Tip>
);

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
  return `${where} at ${run.sha.slice(0, 7)}: ${counts}${run.stale === true ? ' (an older commit than the PR head)' : ''}`;
};

/**
 * The glob's ATF results in one chip: red when any current run has a failing test (a flag only; it never blocks),
 * muted when the only run tested an older commit. It links to the report of the run it summarises.
 */
export const AtfChip = ({ runs }: { runs: readonly AtfRun[] }) => {
  const current = runs.filter((r) => r.stale !== true);
  const shown = current.find((r) => r.failing) ?? current[0] ?? runs[0];
  if (shown === undefined) return null;
  const failing = current.some((r) => r.failing);
  // The text always says what the run found; a stale run is only muted, never shown as passing.
  const text = shown.failing ? `ATF ${shown.failed} failed` : `ATF ${shown.passed}✓`;
  const tone = failing ? 'text-red' : current.length > 0 ? 'text-signal-strong' : 'text-muted-foreground';
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

/** Glob IDs as comma-separated links that open that glob on the board without opening the card they sit on. */
const GlobLinks = ({ boardId, ids }: { boardId: number; ids: readonly string[] }) => (
  <>
    {ids.map((id, i) => (
      <span key={id}>
        {i > 0 && ', '}
        <Link
          to={`/boards/${boardId}?glob=${encodeURIComponent(id)}`}
          className='underline-offset-2 hover:underline'
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {id}
        </Link>
      </span>
    ))}
  </>
);

/**
 * Globs that may change the same files as this one (predicted from the board's merge policy, or set by a person): a note
 * that the later merge rebases, never a hold. Each ID opens that glob on the board.
 */
export const OverlapChip = ({ glob }: { glob: GlobView }) => {
  const overlaps = (glob.impliedAfter ?? []).filter((i) => (i.kind ?? 'overlaps') === 'overlaps' && i.overridden !== true);
  if (overlaps.length === 0 || glob.status === 'reviewing' || glob.status === 'signed_off') return null;
  const reason = overlaps.map((i) => (i.paths.length === 0 ? i.id : `${i.id}: both may change ${i.paths.join(', ')}`)).join('; ');
  return (
    <Tip text={`Overlaps ${reason}. Only the merge order matters: the later one rebases on main`}>
      <span className='max-w-full truncate whitespace-nowrap font-mono text-[11px] text-muted-foreground' data-testid='overlap-chip'>
        overlaps{' '}
        {overlaps.map((o, i) => (
          <span key={o.id}>
            {i > 0 && ', '}
            <Link
              to={`/boards/${glob.boardId}?glob=${encodeURIComponent(o.id)}`}
              className='underline-offset-2 hover:underline'
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {o.id}
            </Link>
          </span>
        ))}
      </span>
    </Tip>
  );
};

/** The size check's flag: the glob looks like more than one PR's worth of work and nobody has answered it yet. */
export const OversizedChip = ({ glob, onOpen }: { glob: GlobView; onOpen?: () => void }) =>
  glob.oversized === true ? (
    <Tip text='Intake judged this more than one PR of work. Open it to split it as proposed, edit the split, or keep it whole'>
      <ChipButton onOpen={onOpen} className='font-mono text-[11px] font-semibold text-required' testId='oversized-chip'>
        Oversized
      </ChipButton>
    </Tip>
  ) : null;

/**
 * "split from <source>" on a part after the first, with the part number and the other parts in the tooltip. A small pill
 * (muted background, sans text, a branch icon) so it is never read as a status.
 */
export const SplitChip = ({ glob, onOpen }: { glob: GlobView; onOpen?: () => void }) => {
  const chip = splitChip(glob);
  if (chip === null) return null;
  return (
    <Tip text={onOpen === undefined ? chip.tip : `${chip.tip}. "split from" opens this glob's split; ${chip.source} opens that glob`}>
      <span
        className='inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border bg-muted px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground'
        data-testid='split-chip'
      >
        <GitBranch className='h-3 w-3 shrink-0' aria-hidden />
        <ChipButton onOpen={onOpen} className='font-sans' testId='split-chip-open'>
          split from
        </ChipButton>{' '}
        <Link
          to={boardGlobHref(glob.boardId, chip.source, { section: 'size' })}
          className='truncate underline-offset-2 hover:underline'
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {chip.source}
        </Link>
      </span>
    </Tip>
  );
};

/**
 * A decision glob's chips: what it applies to, what was decided (the outcome so far) and, when it contradicts a decision of
 * broader scope, which one. Nothing for a work glob.
 */
export const DecisionChips = ({ glob, onOpen }: { glob: GlobView; onOpen?: () => void }) => {
  const attributes = decisionOf(glob);
  if (attributes === null) return null;
  const { outcome } = attributes;
  const conflicts = attributes.conflictsWith ?? [];
  const opens = onOpen === undefined ? '' : '. Opens the decision';
  return (
    <>
      <Tip text={`Applies to ${scopeLabel(attributes.scope)}${opens}`}>
        <ChipButton onOpen={onOpen} className='rounded-sm border px-1.5 font-mono text-[10px] text-muted-foreground' testId='scope-chip'>
          {attributes.scope.kind === 'glob' ? attributes.scope.ref : attributes.scope.kind.replace('_', ' ')}
        </ChipButton>
      </Tip>
      {outcome !== null && (
        <Tip text={`${OUTCOME_TEXT[outcome.kind]} by ${outcome.by}${outcome.reason === undefined ? '' : `: ${outcome.reason}`}${opens}`}>
          <ChipButton onOpen={onOpen} className='font-mono text-[11px] text-signal-strong' testId='outcome-chip'>
            {OUTCOME_TEXT[outcome.kind].toLowerCase()}
          </ChipButton>
        </Tip>
      )}
      {conflicts.length > 0 && (
        <Tip text={`Contradicts ${conflicts.join(', ')}, which apply more broadly and win where they disagree${opens}`}>
          <ChipButton onOpen={onOpen} className='font-mono text-[11px] text-required' testId='conflict-chip'>
            conflicts with {conflicts.join(', ')}
          </ChipButton>
        </Tip>
      )}
    </>
  );
};

/** The muted marker for work still to come that only a person can do (a rollout): shown from the moment it is known, in every column. */
const UpcomingStepsChip = ({ glob, onOpen }: { glob: GlobView; onOpen: () => void }) => {
  const steps = glob.humanSteps ?? [];
  const upcoming = upcomingSteps(steps);
  if (upcoming === null) return null;
  const [first, ...more] = upcoming.kinds;
  const tip = steps
    .filter((s) => s.state === 'pending')
    .map((s) => `${s.title}: due ${dueText(s.due)}`)
    .join('\n');
  return (
    <Tip text={tip}>
      <ChipButton onOpen={onOpen} className='inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground' testId='upcoming-steps-chip'>
        <HumanIcon className='h-3 w-3' decorative />
        {first?.replace(/_/g, ' ')}
        {more.length > 0 && ` +${String(more.length)}`}
      </ChipButton>
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

/**
 * Your turn as a button in the actions row, for the two steps the card runs itself: Merge asks for a second click (Confirm
 * merge, for a few seconds; Esc, blur or the timeout reverts it) and Done runs at once. Steps that need input are the status
 * line's link into the glob view, not a button. The click never reaches the card.
 */
const TurnButton = ({
  glob,
  turn,
  pending,
  onAct,
}: {
  glob: GlobView;
  turn: NonNullable<ReturnType<typeof turnButton>>;
  pending?: Action;
  onAct: (action: Action) => void;
}) => {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  const { status, click } = turn;
  const busy = pending !== undefined;
  const pr = glob.pr === null ? '' : ` #${String(glob.pr.number)}`;
  const verb = click.action === 'merge' ? 'Merge' : 'Done';
  return (
    <Tip text={`${status.tip}\n${clickTip(click, confirming)}`}>
      <button
        type='button'
        className={cn(
          'inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-sm bg-foreground px-1.5 py-0.5 font-mono text-[11px] font-medium text-background hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60',
          confirming && 'bg-required',
        )}
        disabled={busy}
        aria-label={`Your turn: ${verb} PR${pr}`}
        data-testid='your-turn-chip'
        data-kind={status.kind}
        data-confirming={confirming ? 'true' : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (busy) return;
          if (turnStep(click, confirming) === 'confirm') {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          onAct(click.action);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') setConfirming(false);
        }}
        onBlur={() => setConfirming(false)}
      >
        {busy ? <Loader2 className='h-3 w-3 animate-spin' aria-hidden /> : <HumanIcon className='h-3 w-3' decorative />}
        {busy ? workingLabel(pending) : confirming ? `Confirm merge${pr}` : verb}
      </button>
    </Tip>
  );
};

/**
 * The card's title: it wraps over as many lines as it needs (the only text on the card that does) and edits in place, with the
 * glob view's edit logic. Clicks and keys inside it never reach the card, which would open the glob.
 */
const CardTitle = ({
  glob,
  editable,
  onUpdate,
  onReload,
}: {
  glob: GlobView;
  editable: boolean;
  onUpdate: (changes: GlobChanges) => Promise<EditFailure | null>;
  onReload: () => Promise<void>;
}) => {
  const edit = useTitleEdit({ title: glob.title, resetKey: glob.id, onUpdate, onReload });
  const { field, text } = edit;
  // Grow with the text, so the whole title shows while it is typed.
  useEffect(() => {
    const el = field.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${String(el.scrollHeight)}px`;
  }, [field, text, edit.editing]);

  if (!edit.editing) {
    return editable ? (
      <button
        type='button'
        className='group flex w-full min-w-0 cursor-text items-start gap-1 rounded-sm text-left leading-snug font-medium break-words hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring'
        aria-label={`Edit title: ${glob.title}`}
        data-testid='card-title-edit'
        onClick={(e) => {
          e.stopPropagation();
          edit.begin();
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <span className='min-w-0 flex-1 break-words'>{glob.title}</span>
        <Pencil aria-hidden className='mt-0.5 size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100' />
      </button>
    ) : (
      <div className='leading-snug font-medium break-words' data-testid='card-title'>
        {glob.title}
      </div>
    );
  }
  return (
    <div className='min-w-0' onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <textarea
        ref={field}
        rows={1}
        autoFocus
        value={text}
        disabled={edit.saving}
        aria-label='Title'
        aria-invalid={edit.emptyRefused || edit.error !== null}
        data-testid='card-title-input'
        className='block w-full resize-none overflow-hidden rounded border bg-card px-1 text-sm leading-snug font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring'
        onChange={(e) => edit.change(e.target.value)}
        onBlur={edit.commit}
        onKeyDown={edit.onKeyDown}
      />
      {edit.saving && (
        <p role='status' className='text-xs font-normal text-muted-foreground'>
          Saving…
        </p>
      )}
      {edit.emptyRefused && (
        <p role='alert' className='text-xs text-red'>
          The title can't be empty.
        </p>
      )}
      {edit.error !== null && (
        <div role='alert' className='flex flex-wrap items-center gap-2 text-xs text-red'>
          <span>{edit.error.message}</span>
          {edit.error.conflict && (
            <button
              type='button'
              className='rounded-sm border px-1.5 py-0.5 text-foreground hover:bg-muted'
              disabled={edit.saving}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void edit.reload()}
            >
              Reload latest
            </button>
          )}
        </div>
      )}
    </div>
  );
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
  onUpdateTitle,
  onReload,
}: {
  glob: GlobView;
  onOpen: () => void;
  /** Opens the glob at the section (and artifact or label) a chip or icon points to; `onOpen` opens it at the top. */
  onOpenSection: (target: GlobTarget) => void;
  onReviewLabel: ReviewLabel;
  /** Only the moves this glob can make; none means no buttons at all. */
  moves: readonly CardMove[];
  /** The move in flight on this glob, if any: the card shows it working and takes no other move. */
  pending?: Action;
  /** The move whose ghost piece is showing, if it is this card's. */
  previewing: Action | null;
  onPreview: (move: CardMove | null) => void;
  onMove: (move: CardMove) => void;
  /** Runs an action from a chip (Your turn: Merge, Done); the board's own action path, with its pending state. */
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
  /** Saves a new title (the glob view's update call); without it the title is plain text. */
  onUpdateTitle?: (changes: GlobChanges) => Promise<EditFailure | null>;
  /** Loads the glob's latest values after a title save met a newer version. */
  onReload?: () => Promise<void>;
}) => {
  const person = glob.implementer ?? glob.planner;
  const failed = glob.status === 'failed' || glob.failure !== null;
  const age = aging(glob);
  const now = new Date().toISOString();
  const preview = moves.find((m) => m.action === previewing);
  // Decision globs have their own look (an accent edge, scope and outcome) and no labels, branch or routine status.
  const decision = decisionOf(glob) !== null;
  const marker = cornerMarker(glob, now, viewer, repo);
  const position = positionOf(glob, now, viewer);
  const line = cardStatus(glob, now, viewer, repo);
  const blocked = hasBlocker(glob, now, viewer);
  const turn = turnButton(glob, now, viewer, blocked);
  // The board hands over the glob's card moves (the one common action); a blocker hides them all.
  const shown = blocked ? [] : moves;
  const editable = onUpdateTitle !== undefined && glob.status !== 'signed_off';

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
        <span className='inline-flex min-w-0 items-center gap-1.5'>
          <span className='whitespace-nowrap'>
            {glob.id} · {decision ? 'decision' : glob.type}
            {glob.type === 'super' && glob.list === 'planning' ? ' · pairing' : ''}
          </span>
          <CategoryIcon category={glob.category} />
          <Avatar email={person} planner={glob.implementer === null} />
        </span>
        {marker !== null && <CornerMarkerView marker={marker} position={position} onAct={onAct} onOpenSection={onOpenSection} />}
      </div>
      <CardTitle glob={glob} editable={editable} onUpdate={onUpdateTitle ?? (() => Promise.resolve(null))} onReload={onReload ?? (() => Promise.resolve())} />
      {line !== null && (
        <Tip text={line.tip} className='w-full'>
          <div
            className='w-full min-w-0 truncate whitespace-nowrap text-left font-mono text-[11px]'
            data-testid='status-line'
            data-kind={line.kind}
          >
            {line.head !== null && (
              <ChipButton
                onOpen={() => runChip(line.head?.click ?? { kind: 'section', target: cardTargets.actions() }, () => undefined, onOpenSection)}
                className={cn('inline text-left', line.head.tone)}
                testId='status-line-open'
                dataKind={line.head.kind}
              >
                {line.head.text}
              </ChipButton>
            )}
            {line.head !== null && line.waiting !== null && <span className='text-muted-foreground'> · </span>}
            {line.waiting !== null && (
              <span className='text-muted-foreground' data-testid='waiting-on'>
                <ChipButton onOpen={() => onOpenSection(cardTargets.prerequisites())} className='inline' testId='waiting-on-open'>
                  waiting on
                </ChipButton>{' '}
                <GlobLinks boardId={glob.boardId} ids={line.waiting.ids} />
                {line.waiting.more > 0 && ` +${String(line.waiting.more)}`}
                {line.waiting.next !== null && (
                  <>
                    {' · next: '}
                    <GlobLinks boardId={glob.boardId} ids={[line.waiting.next]} />
                  </>
                )}
              </span>
            )}
          </div>
        </Tip>
      )}
      <div className='flex min-w-0 flex-wrap items-center gap-1.5 empty:hidden' data-testid='card-chips'>
        {glob.group !== null && <GroupChip name={glob.group} />}
        {decision ? (
          <DecisionChips glob={glob} onOpen={() => onOpenSection(cardTargets.decision())} />
        ) : (
          <LabelPopover glob={glob} onReview={onReviewLabel} onOpenReview={(label) => onOpenSection(cardTargets.label(label))} />
        )}
        <ArtifactIcons glob={glob} onOpen={onOpenSection} />
        <OverlapChip glob={glob} />
        <SplitChip glob={glob} onOpen={() => onOpenSection(cardTargets.size())} />
        <OversizedChip glob={glob} onOpen={() => onOpenSection(cardTargets.size())} />
        <UpcomingStepsChip glob={glob} onOpen={() => onOpenSection(cardTargets.humanSteps())} />
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
        {glob.provisioning === 'failed' && (
          <Tip text='slop could not create the branch and draft PR; it retries in the background'>
            <ChipButton onOpen={() => onOpenSection(cardTargets.actions())} className='font-mono text-[11px] text-red' testId='provisioning-chip'>
              provisioning failed
            </ChipButton>
          </Tip>
        )}
      </div>
      {(pending !== undefined || turn !== null || shown.length > 0) && (
        <div className='flex min-w-0 flex-wrap items-center gap-1.5' data-testid='card-actions'>
          {pending !== undefined && (
            <span className='inline-flex items-center gap-1 whitespace-nowrap font-mono text-[10px] text-muted-foreground' role='status' data-testid='card-pending'>
              <Loader2 className='size-3 animate-spin' aria-hidden />
              {workingLabel(pending)}
            </span>
          )}
          {turn !== null && <TurnButton glob={glob} turn={turn} pending={pending} onAct={(action) => onAct?.(action)} />}
          {shown.map((move, _i, all) => (
            <MoveButton
              key={move.action}
              move={move}
              hot={move.action === previewing}
              disabled={pending !== undefined}
              primary={mainAction(all.map((m) => m.action), glob, decision) === move.action}
              onPreview={onPreview}
              onMove={onMove}
            />
          ))}
        </div>
      )}
      {tag !== undefined && (
        // Keyed by the move, so a second move's tag restarts its fade.
        <div key={tag.n} className='move-tag font-mono text-[10px] text-muted-foreground' role='status'>
          ▸ {tag.text}
        </div>
      )}
    </div>
  );
};
