import { queuedRunNotice } from '@slop/core';
import type { Action, ArtifactKind, Category, CodeReviewBadge, DeployIndicator, EnvironmentIndicator } from '@slop/core';
import { Bot, Bug, ListChecks, Loader2, MessageSquareCode, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { AtfRun, GlobView } from '@/lib/api';
import type { MoveTag } from '@/lib/board-motion';
import { statusLine } from '@/lib/status-line';
import { cn, groupSticker } from '@/lib/utils';
import { ARTIFACT_META, CARD_ARTIFACT_KINDS } from './artifacts';
import { Tip } from './ui/tip';
import { LabelPopover } from './labels';
import type { ReviewLabel } from './labels';

/** The glob's category as a small icon in the card's corner. */
const CATEGORY_ICON: Record<Category, { icon: LucideIcon; className: string }> = {
  bug: { icon: Bug, className: 'text-red' },
  feature: { icon: Sparkles, className: 'text-muted-foreground' },
  task: { icon: ListChecks, className: 'text-muted-foreground' },
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

const RunIndicator = ({ glob }: { glob: GlobView }) => {
  const run = glob.currentRun;
  // Ended runs are covered by the status line.
  if (run === null || run.state === 'ended') return null;
  const label = run.state;
  const watching = 'Routine session watching the PR to auto-fix CI failures and review comments';
  return (
    <Tip text={queuedRunNotice(glob, new Date().toISOString()) ?? (run.state === 'watching' ? watching : `Routine run ${label}: owned by ${run.routineOwner}, triggered by ${run.triggeredBy}`)}>
    <span
      className='inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground'
    >
      {run.state === 'active' ? <Loader2 className='h-3 w-3 animate-spin' /> : <Bot className='h-3 w-3' />}
      {label}
    </span>
    </Tip>
  );
};

/** Small icons for the artifacts the glob has; each opens the glob view on that artifact. */
const ArtifactIcons = ({ glob, onOpen }: { glob: GlobView; onOpen: (kind: ArtifactKind) => void }) => {
  const present = CARD_ARTIFACT_KINDS.flatMap((kind) => {
    const artifact = glob.artifacts?.find((a) => a.kind === kind);
    return artifact === undefined ? [] : [artifact];
  });
  if (present.length === 0) return null;
  return (
    <span className='inline-flex items-center gap-0.5'>
      {present.map((a) => {
        const { title, icon: Icon } = ARTIFACT_META[a.kind];
        return (
          <Tip key={a.kind} text={`${title} v${a.version}${a.commitSha === null ? '' : ` at ${a.commitSha.slice(0, 7)}`}`}>
          <button
            type='button'
            className='rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground'
            aria-label={title}
            data-testid={`artifact-icon-${a.kind}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(a.kind);
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Icon className='h-3.5 w-3.5' />
          </button>
          </Tip>
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
}

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
}) => (
  <Tip text={move.description}>
  <button
    type='button'
    className={cn(
      'rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold shadow-[0_1px_0_var(--border)] active:translate-y-px active:shadow-none',
      hot ? 'border-foreground bg-lcd text-lcd-foreground' : 'bg-background text-foreground hover:bg-muted',
    )}
    aria-label={move.description}
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
    {move.label}
  </button>
  </Tip>
);

/** The glob's deploy state on its card: deploying, live, failed, or replaced by another glob. */
export const DeployChip = ({ deploy }: { deploy: DeployIndicator }) => {
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
    <Tip text={tip}>
      <span className={cn('inline-flex items-center gap-1 font-mono text-[11px]', tone)} data-testid='deploy-chip'>
        {deploy.state === 'deploying' && !deploy.waiting && <Loader2 className='h-3 w-3 animate-spin' />}
        {text}
      </span>
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

/** CodeRabbit's review of the PR: its inline comment count, opening the review on GitHub. */
export const CodeReviewIcon = ({ badge }: { badge: CodeReviewBadge }) => {
  const comments = `${badge.count} inline comment${badge.count === 1 ? '' : 's'}`;
  const icon = (
    <span className='inline-flex items-center gap-0.5 font-mono text-[11px] text-muted-foreground' data-testid='code-review-icon'>
      <MessageSquareCode className='h-3.5 w-3.5' aria-hidden />
      {badge.count}
    </span>
  );
  return (
    <Tip text={`CodeRabbit: ${comments}${badge.url === null ? '' : '; open the review on GitHub'}`}>
      {badge.url === null ? (
        icon
      ) : (
        <a
          href={badge.url}
          target='_blank'
          rel='noreferrer'
          aria-label={`CodeRabbit review: ${comments}`}
          className='rounded-sm px-0.5 hover:bg-muted hover:text-foreground'
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {icon}
        </a>
      )}
    </Tip>
  );
};

const bumpStyle = (side: 'left' | 'right'): CSSProperties & Record<'--bump', string> => ({
  '--bump': side === 'left' ? '-3px' : '3px',
});

export const GlobCard = ({
  glob,
  onOpen,
  onOpenArtifact,
  onReviewLabel,
  moves,
  previewing,
  onPreview,
  onMove,
  onArrow,
  lock,
  bump,
  tag,
  deploy,
  environments,
  atf,
  codeReview,
}: {
  glob: GlobView;
  onOpen: () => void;
  onOpenArtifact: (kind: ArtifactKind) => void;
  onReviewLabel: ReviewLabel;
  /** Only the moves this glob can make; none means no buttons at all. */
  moves: readonly CardMove[];
  /** The move whose ghost piece is showing, if it is this card's. */
  previewing: Action | null;
  onPreview: (move: CardMove | null) => void;
  onMove: (move: CardMove) => void;
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
  /** CodeRabbit's review of its PR, when CodeRabbit has posted anything. */
  codeReview?: CodeReviewBadge;
}) => {
  const person = glob.implementer ?? glob.planner;
  const failed = glob.status === 'failed' || glob.failure !== null;
  const age = aging(glob);
  const status = statusLine(glob, new Date().toISOString());
  const preview = moves.find((m) => m.action === previewing);

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
          else onMove(preview);
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
      data-glob-id={glob.id}
      data-testid={`card-${glob.id}`}
    >
      <div className='flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground'>
        <span>
          {glob.id} · {glob.type}
        </span>
        <span className='inline-flex items-center gap-1.5'>
          <RunIndicator glob={glob} />
          <CategoryIcon category={glob.category} />
        </span>
      </div>
      <div className='mt-1 leading-snug font-medium'>{glob.title}</div>
      <div className='mt-2 flex flex-wrap items-center gap-1.5'>
        {glob.group !== null && <GroupChip name={glob.group} />}
        <LabelPopover glob={glob} onReview={onReviewLabel} onOpenReview={onOpen} />
        <ArtifactIcons glob={glob} onOpen={onOpenArtifact} />
        {codeReview !== undefined && <CodeReviewIcon badge={codeReview} />}
        {deploy !== undefined && <DeployChip deploy={deploy} />}
        {environments !== undefined && <EnvironmentChips environments={environments} />}
        {atf !== undefined && <AtfChip runs={atf} />}
        {status !== null && (
          <Tip text={status.tip}>
            <span className={cn('font-mono text-[11px]', status.tone)} data-testid='status-line' data-kind={status.kind}>
              {status.text}
            </span>
          </Tip>
        )}
        {age !== 'neutral' && glob.pr?.state === 'draft' && (
          <Tip text='Two or more days in Doing and the PR is still a draft'>
            <span className='font-mono text-[11px] text-muted-foreground'>PR still draft</span>
          </Tip>
        )}
        {glob.provisioning === 'failed' && (
          <Tip text='slop could not create the branch and draft PR; it retries in the background'>
            <span className='font-mono text-[11px] text-red'>provisioning failed</span>
          </Tip>
        )}
        <span className='ml-auto inline-flex items-center gap-1'>
          {moves.map((move) => (
            <MoveButton
              key={move.action}
              move={move}
              hot={move.action === previewing}
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
