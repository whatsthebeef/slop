import { decisionOf, dueText, findingsLabel, reviewOutdated, scopeLabel, upcomingSteps } from '@slop/core';
import type { Action, Category, DeployIndicator, EnvironmentIndicator, HumanStepViewer } from '@slop/core';
import { AlertTriangle, Bug, Hourglass, ListChecks, Loader2, Scale, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ActorIcon, HumanIcon } from '@/components/actor-icons';
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import type { AtfRun, GlobView } from '@/lib/api';
import type { ActionIcon } from '@/lib/action-presentation';
import type { MoveTag } from '@/lib/board-motion';
import { onStandby, positionOf } from '@/lib/position';
import type { Position } from '@/lib/position';
import { blockedParts, chainTip, statusLine } from '@/lib/status-line';
import type { StatusLine } from '@/lib/status-line';
import { cn, groupSticker } from '@/lib/utils';
import { ARTIFACT_META, CARD_ARTIFACT_KINDS } from './artifacts';
import { OUTCOME_TEXT } from './decision-section';
import { actionTiers } from '@/lib/action-style';
import { workingLabel } from '@/lib/card-pending';
import { splitChip } from '@/lib/split-chip';
import { positionClick, CONFIRM_MS, clickTip, prUrl, statusClick, turnStep, yourTurnClick } from '@/lib/chip-actions';
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
      <span className='sticker rounded-sm px-1.5 font-mono text-[10px] font-semibold' style={colours}>
        {name}
      </span>
    </Tip>
  );
};

/**
 * The one position indicator, shared with the glob view: who has the ball and what they are doing. The viewer's own turn is
 * the Your turn chip, so this shows nothing for it. Standby stays a small muted marker beside whatever holds the ball.
 */
export const PositionLabel = ({
  glob,
  repo,
  viewer,
  onAct,
  onOpenSection,
}: {
  glob: GlobView;
  repo?: string;
  viewer?: HumanStepViewer;
  onAct?: (action: Action) => void;
  onOpenSection?: (target: GlobTarget) => void;
}) => {
  const now = new Date().toISOString();
  const position = positionOf(glob, now, viewer);
  const standby = onStandby(glob);
  if (position === null && standby === null) return null;
  const click = position === null ? null : positionClick(position, glob, repo);
  const open = click === null || onOpenSection === undefined ? undefined : () => runChip(click, onAct ?? (() => undefined), onOpenSection);
  return (
    <>
      {position !== null && click !== null && (
        <Tip text={open === undefined ? position.tip : `${position.tip}\n${clickTip(click)}`}>
          <ChipButton onOpen={open} className={cn('inline-flex items-center gap-1 font-mono text-[11px]', position.tone)} testId='position' dataKind={position.holder}>
            <PositionIcon position={position} />
            {position.text}
          </ChipButton>
        </Tip>
      )}
      {standby !== null && position?.holder !== 'machine' && (
        <Tip text="Machine on standby: fixes new CI failures or review comments until it's merged.">
          <span className='inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground' data-testid='standby'>
            <ActorIcon actor='machine' className='h-3 w-3' decorative />
            standby
          </span>
        </Tip>
      )}
    </>
  );
};

const PositionIcon = ({ position }: { position: Position }) => {
  if (position.spinning) return <Loader2 className='h-3 w-3 animate-spin' aria-hidden />;
  if (position.holder === 'waiting') return <Hourglass className='h-3 w-3' aria-hidden />;
  if (position.holder === 'stalled') return <AlertTriangle className='h-3 w-3' aria-hidden />;
  return <ActorIcon actor={position.holder === 'human' ? 'human' : 'machine'} className='h-3 w-3' decorative />;
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
    <span className={className} data-testid={testId} data-kind={dataKind} aria-describedby={describedBy}>
      {children}
    </span>
  ) : (
    <CardButton
      onOpen={onOpen}
      className={cn(className, 'cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring')}
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

/** One move the glob can make: a state-machine action into a neighbouring list. */
export interface CardMove {
  readonly action: Action;
  readonly direction: 'left' | 'right';
  /** The verb on the button, e.g. "Pick up ▸". */
  readonly label: string;
  /** What it does, for screen readers and the tooltip. */
  readonly description: string;
  /** Who does the work, from actionPresentation; decorative, since the description says it in words. */
  readonly icon: ActionIcon | null;
}

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
            className={cn('font-mono text-[11px]', warned ? 'text-required' : 'text-signal-strong')}
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
    <span className={cn('font-mono text-[11px]', tone)} data-testid='atf-chip' data-failing={failing}>
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
 * A glob held for others to merge: "waits for s15t7", or the reason when the board's merge policy held it. Each ID opens
 * that glob on the board.
 */
export const AfterChip = ({ glob, onOpen }: { glob: GlobView; onOpen?: () => void }) => {
  const blocked = blockedParts(glob);
  if (blocked !== null) {
    return (
      <Tip text={`Waits for, in order: ${chainTip(glob)}${onOpen === undefined ? '' : `. "blocked by" opens this glob's prerequisites; each ID opens that glob`}`}>
        <span className='font-mono text-[11px] text-muted-foreground' data-testid='after-chip'>
          <ChipButton onOpen={onOpen} className='font-mono' testId='after-chip-open'>
            blocked by
          </ChipButton>{' '}
          <GlobLinks boardId={glob.boardId} ids={blocked.ids} />
          {blocked.more > 0 && ` +${String(blocked.more)}`}
          {blocked.next !== null && (
            <>
              {' · next: '}
              <GlobLinks boardId={glob.boardId} ids={[blocked.next]} />
            </>
          )}
        </span>
      </Tip>
    );
  }
  if (glob.status !== 'planning') return null;
  // Only needs hold a glob: explicit `after` and needs slop learned from a failed run. Overlaps show in OverlapChip.
  const learned = (glob.impliedAfter ?? []).filter((i) => i.overridden !== true && i.kind === 'needs');
  const ids = [...new Set([...(glob.after ?? []), ...learned.map((i) => i.id)])];
  if (ids.length === 0) return null;
  const reason = learned.map((i) => `${i.id}: ${i.evidence ?? 'a run failed without it'}`).join('; ');
  return (
    <Tip
      text={`${reason === '' ? `Waits for ${ids.join(', ')} to merge` : `Waits for ${reason}`}${onOpen === undefined ? '' : `. "waits for" opens this glob's prerequisites; each ID opens that glob`}`}
    >
      <span className='font-mono text-[11px] text-muted-foreground' data-testid='after-chip'>
        <ChipButton onOpen={onOpen} className='font-mono' testId='after-chip-open'>
          waits for
        </ChipButton>{' '}
        <GlobLinks boardId={glob.boardId} ids={ids} />
      </span>
    </Tip>
  );
};

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
      <span className='font-mono text-[11px] text-muted-foreground' data-testid='overlap-chip'>
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

/** "split from <source>" on a part after the first, with the part number and the other parts in the tooltip. */
export const SplitChip = ({ glob, onOpen }: { glob: GlobView; onOpen?: () => void }) => {
  const chip = splitChip(glob);
  if (chip === null) return null;
  return (
    <Tip text={onOpen === undefined ? chip.tip : `${chip.tip}. "split from" opens this glob's split; ${chip.source} opens that glob`}>
      <span className='font-mono text-[11px] text-muted-foreground' data-testid='split-chip'>
        <ChipButton onOpen={onOpen} className='font-mono' testId='split-chip-open'>
          split from
        </ChipButton>{' '}
        <Link
          to={boardGlobHref(glob.boardId, chip.source, { section: 'size' })}
          className='underline-offset-2 hover:underline'
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
const UpcomingStepsChip = ({ glob }: { glob: GlobView }) => {
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
      <span className='inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground' data-testid='upcoming-steps-chip'>
        <HumanIcon className='h-3 w-3' decorative />
        {first?.replace(/_/g, ' ')}
        {more.length > 0 && ` +${String(more.length)}`}
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

/**
 * Your turn: a button that runs its step. Merge asks for a second click (Confirm merge, for a few seconds; Esc or the
 * timeout reverts it); steps that need input open the glob view where they are done. The click never reaches the card.
 */
const YourTurnChip = ({
  glob,
  status,
  pending,
  onAct,
  onOpenSection,
}: {
  glob: GlobView;
  status: StatusLine;
  pending?: Action;
  onAct: (action: Action) => void;
  onOpenSection: (target: GlobTarget) => void;
}) => {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  const click = yourTurnClick(status, glob);
  const busy = pending !== undefined && click.kind === 'act';
  const pr = glob.pr === null ? '' : ` #${String(glob.pr.number)}`;
  const verb = click.kind === 'act' && click.action === 'merge' ? 'Merge' : status.text;
  return (
    <Tip text={`${status.tip}\n${clickTip(click, confirming)}`}>
      <button
        type='button'
        className={cn(
          'inline-flex cursor-pointer items-center gap-1 rounded-sm bg-foreground px-1.5 py-0.5 font-mono text-[11px] font-medium text-background hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60',
          confirming && 'bg-required',
        )}
        disabled={busy}
        aria-label={click.kind === 'act' ? `Your turn: ${verb} PR${pr}` : `Your turn: ${status.text}`}
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
          runChip(click, onAct, onOpenSection);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') setConfirming(false);
        }}
        onBlur={() => setConfirming(false)}
      >
        {busy ? <Loader2 className='h-3 w-3 animate-spin' aria-hidden /> : <HumanIcon className='h-3 w-3' decorative />}
        {busy ? (
          workingLabel(pending)
        ) : confirming ? (
          `Confirm merge${pr}`
        ) : (
          <>
            Your turn <span className='font-normal opacity-70'>· {status.text}</span>
          </>
        )}
      </button>
    </Tip>
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
}) => {
  const person = glob.implementer ?? glob.planner;
  const failed = glob.status === 'failed' || glob.failure !== null;
  const age = aging(glob);
  const status = statusLine(glob, new Date().toISOString(), viewer);
  const preview = moves.find((m) => m.action === previewing);
  // Decision globs have their own look (an accent edge, scope and outcome) and no labels, branch or routine status.
  const decision = decisionOf(glob) !== null;

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
        'card-edge relative cursor-pointer rounded-md border px-3 py-2.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
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
      <div className='flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground'>
        <span>
          {glob.id} · {decision ? 'decision' : glob.type}
          {glob.type === 'super' && glob.list === 'planning' ? ' · pairing' : ''}
        </span>
        <span className='inline-flex items-center gap-1.5'>
          <PositionLabel glob={glob} repo={repo} viewer={viewer} onAct={onAct} onOpenSection={onOpenSection} />
          <CategoryIcon category={glob.category} />
        </span>
      </div>
      <div className='mt-1 leading-snug font-medium break-words'>{glob.title}</div>
      <div className='mt-2 flex flex-wrap items-center gap-1.5'>
        {glob.group !== null && <GroupChip name={glob.group} />}
        {decision ? (
          <DecisionChips glob={glob} onOpen={() => onOpenSection(cardTargets.decision())} />
        ) : (
          <LabelPopover glob={glob} onReview={onReviewLabel} onOpenReview={(label) => onOpenSection(cardTargets.label(label))} />
        )}
        <ArtifactIcons glob={glob} onOpen={onOpenSection} />
        <AfterChip glob={glob} onOpen={() => onOpenSection(cardTargets.prerequisites())} />
        <OverlapChip glob={glob} />
        <SplitChip glob={glob} onOpen={() => onOpenSection(cardTargets.size())} />
        <OversizedChip glob={glob} onOpen={() => onOpenSection(cardTargets.size())} />
        <UpcomingStepsChip glob={glob} />
        {glob.clash != null && (
          <Tip text={`${glob.clash.with} also changes ${glob.clash.paths.join(', ')}; whichever merges second will conflict. Opens the conflict`}>
            <ChipButton onOpen={() => onOpenSection(cardTargets.conflict())} className='font-mono text-[11px] text-required' testId='clash-chip'>
              clashes with {glob.clash.with}
            </ChipButton>
          </Tip>
        )}
        {deploy !== undefined && <DeployChip deploy={deploy} onOpen={() => onOpenSection(cardTargets.deploys())} />}
        {environments !== undefined && <EnvironmentChips environments={environments} />}
        {atf !== undefined && <AtfChip runs={atf} />}
        {status !== null && !decision && status.kind === 'ready' && (
          <YourTurnChip glob={glob} status={status} pending={pending} onAct={(action) => onAct?.(action)} onOpenSection={onOpenSection} />
        )}
        {status !== null && !decision && status.kind !== 'ready' && (
          <Tip text={`${status.tip}\n${clickTip(statusClick(status))}`}>
            <ChipButton
              onOpen={() => runChip(statusClick(status), () => undefined, onOpenSection)}
              className={cn('font-mono text-[11px]', status.tone)}
              testId='status-line'
              dataKind={status.kind}
            >
              {status.text}
            </ChipButton>
          </Tip>
        )}
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
        <span className='ml-auto inline-flex items-center gap-1'>
          {glob.escalation != null && glob.status === 'planning' && (
            // The visible words are hidden: the button's label names it and the Tip's description gives the reason.
            <Tip text={`Needs a person: ${glob.escalation.reason}. Opens the reason`}>
              <ChipButton
                onOpen={() => onOpenSection(cardTargets.escalation())}
                className='inline-flex items-center gap-1 font-mono text-[11px] text-required'
                testId='escalation-chip'
                ariaLabel='Needs a person'
              >
                <span aria-hidden className='inline-flex items-center gap-1'>
                  needs a <HumanIcon className='h-3 w-3' decorative />
                </span>
              </ChipButton>
            </Tip>
          )}
          {pending !== undefined && (
            <span className='inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground' role='status' data-testid='card-pending'>
              <Loader2 className='size-3 animate-spin' aria-hidden />
              {workingLabel(pending)}
            </span>
          )}
          {moves.map((move, _i, all) => (
            <MoveButton
              key={move.action}
              move={move}
              hot={move.action === previewing}
              disabled={pending !== undefined}
              primary={actionTiers(all.map((m) => m.action)).get(move.action) === 'primary'}
              onPreview={onPreview}
              onMove={onMove}
            />
          ))}
          <Avatar email={person} planner={glob.implementer === null} />
        </span>
      </div>
      {tag !== undefined && (
        // Keyed by the move, so a second move's tag restarts its fade.
        <div key={tag.n} className='move-tag mt-1.5 font-mono text-[10px] text-muted-foreground' role='status'>
          ▸ {tag.text}
        </div>
      )}
    </div>
  );
};
