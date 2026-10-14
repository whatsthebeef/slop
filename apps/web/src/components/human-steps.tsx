import { isForViewer } from '@slop/core';
import type { HumanStepViewer } from '@slop/core';
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import type { GlobView, ListedHumanStep } from '@/lib/api';
import {
  defaultStepsOpen,
  dismissReason,
  EMPTY_DRAFT,
  isWorkStep,
  readStepsOpen,
  scriptArtifactPath,
  scriptCopyText,
  stateText,
  stepInput,
  whoText,
  writeStepsOpen,
} from '@/lib/human-steps';
import type { StepDraft } from '@/lib/human-steps';
import { copyOrSelect } from '@/lib/plan-text';
import { cn } from '@/lib/utils';
import { HumanIcon } from './actor-icons';
import { SectionToggle } from './section-toggle';
import { Button } from './ui/button';
import { Input, Label, Select } from './ui/input';

interface StepActions {
  /** Each resolves false when the request failed (the page says why). */
  readonly onAdd: (step: { title: string; detail?: string; who?: string; due?: string }) => Promise<boolean>;
  readonly onComplete: (stepId: string) => Promise<boolean>;
  readonly onDismiss: (stepId: string, reason: string) => Promise<boolean>;
}

const Step = ({ glob, step, mine, busy, actions }: { glob: GlobView; step: ListedHumanStep; mine: boolean; busy: boolean; actions: StepActions }) => {
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState(false);
  const work = isWorkStep(step);
  const open = step.state === 'due' || step.state === 'pending';
  const script = step.script ?? null;
  const copy = async () => {
    const text = await scriptCopyText(glob.boardId, glob.id, script ?? { path: '' }, api.rolloutScript, window.location.origin);
    setCopied(await copyOrSelect(text, typeof navigator === 'undefined' ? undefined : navigator.clipboard, () => undefined));
  };
  const reasonText = dismissReason(reason);
  return (
    <li
      className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded border p-2 text-xs', mine && step.state === 'due' && 'border-foreground')}
      data-testid='human-step'
      data-state={step.state}
      data-kind={step.kind}
    >
      <div className='flex flex-wrap items-center gap-2'>
        {work && (
          <input
            type='checkbox'
            aria-label={`Done: ${step.title}`}
            data-testid='step-tick'
            checked={step.state === 'done'}
            disabled={busy || !open}
            onChange={() => void actions.onComplete(step.id)}
          />
        )}
        <HumanIcon decorative />
        <span className={cn('min-w-0 break-words font-medium [overflow-wrap:anywhere]', (step.state === 'dismissed' || step.state === 'done') && 'text-muted-foreground line-through')} data-testid='step-title'>
          {step.title}
        </span>
        <span className='font-mono text-[11px] text-muted-foreground'>{step.kind.replace(/_/g, ' ')}</span>
        {mine && step.state === 'due' && <span className='rounded-sm bg-foreground px-1 font-mono text-[10px] text-background'>Your turn</span>}
      </div>
      <div className='flex flex-wrap gap-x-3 break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]'>
        <span data-testid='step-who'>for {whoText(step.who)}</span>
        <span data-testid='step-state'>{stateText(step)}</span>
        {step.check != null && step.check !== '' && <span data-testid='step-check'>checked by slop: {step.check}</span>}
      </div>
      {step.detail != null && step.detail !== '' && <p className='whitespace-pre-wrap break-words [overflow-wrap:anywhere]'>{step.detail}</p>}
      {script !== null && (
        <div className='flex flex-wrap items-center gap-2 text-[11px]'>
          {'path' in script ? (
            <code className='break-all font-mono' data-testid='step-script-path'>
              {script.path}
            </code>
          ) : (
            <Link className='min-w-0 break-words underline [overflow-wrap:anywhere]' to={scriptArtifactPath(glob.boardId, glob.id, script)} data-testid='step-script-link'>
              Rollout script: {script.artifact}
            </Link>
          )}
          <Button size='sm' variant='outline' data-testid='step-copy' onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
      {work && open && !dismissing && (
        <button type='button' className='justify-self-start text-[11px] underline' data-testid='step-dismiss' onClick={() => setDismissing(true)}>
          Dismiss
        </button>
      )}
      {dismissing && (
        <form
          className='flex flex-wrap items-end gap-2'
          onSubmit={(e) => {
            e.preventDefault();
            if (reasonText === null) return;
            void actions.onDismiss(step.id, reasonText).then((ok) => {
              if (ok) setDismissing(false);
            });
          }}
        >
          <Label className='min-w-0 grow'>
            Why is this step wrong?
            <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid='dismiss-reason' />
          </Label>
          <Button size='sm' type='submit' disabled={busy || reasonText === null} data-testid='dismiss-confirm'>
            Dismiss step
          </Button>
          <Button size='sm' type='button' variant='ghost' onClick={() => setDismissing(false)}>
            Cancel
          </Button>
        </form>
      )}
    </li>
  );
};

const AddStep = ({ busy, onAdd, onClose }: { busy: boolean; onAdd: StepActions['onAdd']; onClose: () => void }) => {
  const [draft, setDraft] = useState<StepDraft>(EMPTY_DRAFT);
  const input = stepInput(draft);
  return (
    <form
      className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded border p-2'
      data-testid='add-step-form'
      onSubmit={(e) => {
        e.preventDefault();
        if (input === null) return;
        void onAdd(input).then((ok) => {
          if (!ok) return;
          setDraft(EMPTY_DRAFT);
          onClose();
        });
      }}
    >
      <Label>
        Title
        <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} data-testid='step-title-input' />
      </Label>
      <Label>
        Detail (optional)
        <Input value={draft.detail} onChange={(e) => setDraft({ ...draft, detail: e.target.value })} data-testid='step-detail-input' />
      </Label>
      <div className='grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2'>
        <Label>
          Who (a role or an email)
          <Input value={draft.who} onChange={(e) => setDraft({ ...draft, who: e.target.value })} data-testid='step-who-input' />
        </Label>
        <Label>
          When
          <Select value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })} data-testid='step-due-input'>
            <option value='after_merge'>After the merge</option>
            <option value='now'>Now</option>
          </Select>
        </Label>
      </div>
      <div className='flex gap-2'>
        <Button size='sm' type='submit' disabled={busy || input === null} data-testid='add-step-submit'>
          Add step
        </Button>
        <Button size='sm' type='button' variant='ghost' onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
};

/**
 * The glob view's Human steps: everything only a person can do on the glob, each with who it is for and when it falls
 * due. Stored work steps (a rollout) are ticked here, which records who and when, or dismissed with a reason; steps the
 * machine implies are shown but done by their own actions. Members can add a step. The section collapses to its
 * heading and count; the viewer's toggle is remembered, until then it starts open while a step is still to do.
 * The page replaces the glob after each change, so this holds no copy of the steps.
 */
export const HumanSteps = ({
  glob,
  viewer,
  canAdd,
  startOpen = false,
  openSignal = 0,
  collapsed = false,
  ...actions
}: {
  glob: GlobView;
  viewer?: HumanStepViewer;
  canAdd: boolean;
  /** A `section=human-steps` link opens it. */
  startOpen?: boolean;
  /** Bumped by the main button: opens the section again if the viewer collapsed it. */
  openSignal?: number;
  /** Starts collapsed whatever is still to do (a decision glob: the steps sit below the assessments). */
  collapsed?: boolean;
} & StepActions) => {
  const steps = glob.humanSteps ?? [];
  const [toggled, setToggled] = useState<boolean | null>(() => (startOpen ? true : collapsed ? false : readStepsOpen()));
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (openSignal > 0) setToggled(true);
  }, [openSignal]);
  if (steps.length === 0 && !canAdd) return null;
  const open = toggled ?? defaultStepsOpen(steps);
  const toggle = () => {
    setToggled(!open);
    writeStepsOpen(!open);
  };
  const guarded =
    <A extends unknown[]>(work: (...args: A) => Promise<boolean>) =>
    async (...args: A) => {
      setBusy(true);
      try {
        return await work(...args);
      } finally {
        setBusy(false);
      }
    };
  const wrapped: StepActions = { onAdd: guarded(actions.onAdd), onComplete: guarded(actions.onComplete), onDismiss: guarded(actions.onDismiss) };
  const left = steps.filter((s) => s.state === 'due' || s.state === 'pending').length;
  return (
    <section className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2' aria-label='Human steps' data-testid='human-steps'>
      <div className='flex items-center gap-2'>
        <SectionToggle open={open} onToggle={toggle} testId='human-steps-toggle'>
          Human steps ({steps.length})
          {!open && left > 0 && (
            <span className='rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground' data-testid='human-steps-left'>
              {left} to do
            </span>
          )}
        </SectionToggle>
        {canAdd && (
          <Button
            size='sm'
            variant='ghost'
            className='h-6 gap-1 px-1.5 text-xs'
            data-testid='add-step'
            onClick={() => {
              setAdding(!(adding && open));
              setToggled(true);
            }}
          >
            <Plus className='h-3.5 w-3.5' />
            Add step
          </Button>
        )}
      </div>
      {open && (
        <>
          {steps.length > 0 && (
            <ul className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2'>
              {steps.map((s) => (
                <Step
                  key={s.id}
                  glob={glob}
                  step={s}
                  mine={viewer !== undefined && isForViewer(s, glob, viewer)}
                  busy={busy}
                  actions={wrapped}
                />
              ))}
            </ul>
          )}
          {canAdd && adding && <AddStep busy={busy} onAdd={wrapped.onAdd} onClose={() => setAdding(false)} />}
        </>
      )}
    </section>
  );
};
