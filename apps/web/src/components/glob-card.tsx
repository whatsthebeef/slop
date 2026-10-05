import { useDraggable } from '@dnd-kit/core';
import type { ArtifactKind, LabelName, LabelState } from '@slop/core';
import { AlertTriangle, Bot, Loader2 } from 'lucide-react';
import type { GlobView } from '@/lib/api';
import { cn, groupHue } from '@/lib/utils';
import { ARTIFACT_META, CARD_ARTIFACT_KINDS } from './artifacts';
import { LabelSwitches } from './labels';

const TYPE_STYLE = {
  sub: 'border-l-sub',
  same: 'border-l-same',
  super: 'border-l-super',
} as const;

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

const short = (email: string | null) => (email === null ? '' : email.split('@')[0]);

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

export const GlobCard = ({
  glob,
  onOpen,
  onOpenArtifact,
  onSwitchLabel,
}: {
  glob: GlobView;
  onOpen: () => void;
  onOpenArtifact: (kind: ArtifactKind) => void;
  onSwitchLabel: (label: LabelName, state: LabelState) => void;
}) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: glob.id, data: { glob } });
  const person = glob.implementer ?? glob.planner;
  const failed = glob.status === 'failed' || glob.failure !== null;
  const age = aging(glob);

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className={cn(
        'cursor-pointer rounded-md border border-l-4 bg-card p-2.5 text-sm shadow-sm hover:shadow',
        TYPE_STYLE[glob.type],
        AGING_STYLE[age],
        isDragging && 'opacity-40',
        failed && 'ring-1 ring-red',
      )}
      data-testid={`card-${glob.id}`}
    >
      <div className='flex items-center justify-between gap-2 text-[11px] text-muted-foreground'>
        <span className='font-mono'>
          {glob.id} · {glob.type}
        </span>
        <RunIndicator glob={glob} />
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
        <span className='ml-auto text-[11px] text-muted-foreground' title={person}>
          {glob.implementer === null ? 'planner ' : ''}
          {short(person)}
        </span>
      </div>
    </div>
  );
};
