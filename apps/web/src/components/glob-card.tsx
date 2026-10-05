import type { ArtifactKind, Category, LabelName, LabelState } from '@slop/core';
import { AlertTriangle, Bot, Bug, ChevronLeft, ChevronRight, ListChecks, Loader2, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { GlobView } from '@/lib/api';
import { cn, groupHue } from '@/lib/utils';
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

const AGING_STYLE = { neutral: '', amber: 'bg-amber/15', red: 'bg-red/15' } as const;

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
      'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground',
      planner && 'border border-dashed border-muted-foreground/60 bg-transparent',
    )}
    title={`${planner ? 'Planner' : 'Implementer'}: ${email}`}
  >
    {initials(email)}
  </span>
);

/** A thin, full-height arrow on the card's edge that moves the glob to the next list. */
const MoveArrow = ({ side, label, onClick }: { side: 'left' | 'right'; label: string; onClick: () => void }) => (
  <button
    type='button'
    className={cn(
      'absolute inset-y-0 flex w-4 items-center justify-center text-muted-foreground/70 hover:bg-muted hover:text-foreground',
      side === 'left' ? 'left-0 rounded-l-md' : 'right-0 rounded-r-md',
    )}
    aria-label={label}
    title={label}
    data-testid={`move-${side}`}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    onKeyDown={(e) => e.stopPropagation()}
  >
    {side === 'left' ? <ChevronLeft className='h-3.5 w-3.5' /> : <ChevronRight className='h-3.5 w-3.5' />}
  </button>
);

export const GroupChip = ({ name }: { name: string }) => (
  <span
    className='rounded px-1.5 text-[11px] font-medium'
    style={{
      background: `oklch(0.9 0.06 ${groupHue(name)})`,
      color: `oklch(0.35 0.08 ${groupHue(name)})`,
    }}
  >
    {name}
  </span>
);

const RunIndicator = ({ glob }: { glob: GlobView }) => {
  const run = glob.currentRun;
  if (run === null) return null;
  const label = run.state === 'ended' ? (run.outcome ?? 'ended') : run.state;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11px]',
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
            className='rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground'
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

export type CardMotion = { readonly phase: 'out' | 'in'; readonly direction: 'left' | 'right' };

export const GlobCard = ({
  glob,
  onOpen,
  onOpenArtifact,
  onSwitchLabel,
  moveLeft,
  moveRight,
  motion,
}: {
  glob: GlobView;
  onOpen: () => void;
  onOpenArtifact: (kind: ArtifactKind) => void;
  onSwitchLabel: (label: LabelName, state: LabelState) => void;
  /** Present only when the glob can move that way; the label names the target list. */
  moveLeft?: { label: string; onMove: () => void };
  moveRight?: { label: string; onMove: () => void };
  /** A move animation in progress: splatting out of this list, or plopping into its new one. */
  motion?: CardMotion;
}) => {
  const person = glob.implementer ?? glob.planner;
  const failed = glob.status === 'failed' || glob.failure !== null;
  const age = aging(glob);

  return (
    <div
      role='button'
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className={cn(
        // Every card keeps room for both arrows, so text lines up across cards.
        'relative cursor-pointer rounded-md border bg-card px-5 py-2.5 text-sm shadow-sm hover:shadow',
        motion?.phase === 'out' && 'slop-out',
        motion?.phase === 'in' && 'slop-in',
        AGING_STYLE[age],
        failed && 'ring-1 ring-red',
      )}
      data-slop-dir={motion?.direction}
      data-testid={`card-${glob.id}`}
    >
      <div className='flex items-center justify-between gap-2 text-[11px] text-muted-foreground'>
        <span className='font-mono'>
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
          <span className='inline-flex items-center gap-1 text-[11px] text-red' title={glob.failure?.reason}>
            <AlertTriangle className='h-3 w-3' /> failed
          </span>
        )}
        {age !== 'neutral' && glob.pr?.state === 'draft' && (
          <span className='text-[11px] text-muted-foreground'>PR still draft</span>
        )}
        {glob.provisioning === 'failed' && <span className='text-[11px] text-red'>provisioning failed</span>}
        <span className='ml-auto'>
          <Avatar email={person} planner={glob.implementer === null} />
        </span>
      </div>
      {moveLeft !== undefined && <MoveArrow side='left' label={moveLeft.label} onClick={moveLeft.onMove} />}
      {moveRight !== undefined && <MoveArrow side='right' label={moveRight.label} onClick={moveRight.onMove} />}
    </div>
  );
};
