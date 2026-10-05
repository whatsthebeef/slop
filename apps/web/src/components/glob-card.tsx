import type { Action, ArtifactKind, Category, LabelName, LabelState } from '@slop/core';
import { Bot, Bug, ListChecks, Loader2, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { GlobView } from '@/lib/api';
import type { MoveTag } from '@/lib/board-motion';
import { cn, groupSticker } from '@/lib/utils';
import { ARTIFACT_META, CARD_ARTIFACT_KINDS } from './artifacts';
import { LabelSwitches } from './labels';

/** The glob's category as a small icon in the card's corner. */
const CATEGORY_ICON: Record<Category, { icon: LucideIcon; className: string }> = {
  bug: { icon: Bug, className: 'text-red' },
  feature: { icon: Sparkles, className: 'text-muted-foreground' },
  task: { icon: ListChecks, className: 'text-muted-foreground' },
};

const CategoryIcon = ({ category }: { category: Category }) => {
  const { icon: Icon, className } = CATEGORY_ICON[category];
  return (
    <span title={category} className='inline-flex'>
      <Icon className={cn('h-3.5 w-3.5 shrink-0', className)} aria-label={category} role='img' />
    </span>
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
  <span
    className={cn(
      'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border font-mono text-[9px] font-semibold',
      planner ? 'border-dashed border-muted-foreground text-muted-foreground' : 'bg-muted text-foreground',
    )}
    title={`${planner ? 'Planner' : 'Implementer'}: ${email}`}
  >
    {initials(email)}
  </span>
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
    <span className='sticker rounded-sm px-1.5 font-mono text-[10px] font-semibold' style={colours}>
      {name}
    </span>
  );
};

const RunIndicator = ({ glob }: { glob: GlobView }) => {
  const run = glob.currentRun;
  if (run === null) return null;
  const label = run.state === 'ended' ? (run.outcome ?? 'ended') : run.state;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-mono text-[11px]',
        run.outcome === 'failed' ? 'text-red' : 'text-muted-foreground',
      )}
      title={`Routine owned by ${run.routineOwner}, triggered by ${run.triggeredBy}`}
    >
      {run.state === 'active' ? <Loader2 className='h-3 w-3 animate-spin' /> : <Bot className='h-3 w-3' />}
      {label}
    </span>
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
          <button
            key={a.kind}
            type='button'
            className='rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground'
            title={`${title} v${a.version}${a.commitSha === null ? '' : ` at ${a.commitSha.slice(0, 7)}`}`}
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
  <button
    type='button'
    className={cn(
      'rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold shadow-[0_1px_0_var(--border)] active:translate-y-px active:shadow-none',
      hot ? 'border-foreground bg-lcd text-lcd-foreground' : 'bg-background text-foreground hover:bg-muted',
    )}
    aria-label={move.description}
    title={move.description}
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
);

const bumpStyle = (side: 'left' | 'right'): CSSProperties & Record<'--bump', string> => ({
  '--bump': side === 'left' ? '-3px' : '3px',
});

export const GlobCard = ({
  glob,
  onOpen,
  onOpenArtifact,
  onSwitchLabel,
  moves,
  previewing,
  onPreview,
  onMove,
  onArrow,
  lock,
  bump,
  tag,
}: {
  glob: GlobView;
  onOpen: () => void;
  onOpenArtifact: (kind: ArtifactKind) => void;
  onSwitchLabel: (label: LabelName, state: LabelState) => void;
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
}) => {
  const person = glob.implementer ?? glob.planner;
  const failed = glob.status === 'failed' || glob.failure !== null;
  const age = aging(glob);
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
        <LabelSwitches glob={glob} onSwitch={onSwitchLabel} />
        <ArtifactIcons glob={glob} onOpen={onOpenArtifact} />
        {failed && (
          <span className='font-mono text-[11px] font-semibold text-red' title={glob.failure?.reason}>
            ! failed
          </span>
        )}
        {age !== 'neutral' && glob.pr?.state === 'draft' && (
          <span className='font-mono text-[11px] text-muted-foreground'>PR still draft</span>
        )}
        {glob.provisioning === 'failed' && (
          <span className='font-mono text-[11px] text-red'>provisioning failed</span>
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
