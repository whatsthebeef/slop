import { isForViewer } from '@slop/core';
import type { HumanStepScript, HumanStepViewer } from '@slop/core';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '@/lib/api';
import { Block } from './glob-view/block';
import type { GlobView, ListedHumanStep } from '@/lib/api';
import {
  defaultStepsOpen,
  dueWorkSteps,
  dismissalText,
  dismissReason,
  EMPTY_DRAFT,
  isDismissedStep,
  isWorkStep,
  isQuietStep,
  PREDICTED_ROLLOUT_TEXT,
  quietText,
  readStepsOpen,
  scriptArtifactPath,
  scriptCopyText,
  scriptRunCommand,
  scriptSourceUrl,
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
import { StepDetail } from './step-detail';
import { InlineMarkdown, MarkdownView } from './markdown-view';
import { stripMarkdown } from '@/lib/markdown-text';
import { Button } from './ui/button';
import { Input, Label, Select } from './ui/input';

/**
 * The ref a script's GitHub link points at: the squash commit of the latest PR slop recorded as merged (a super's Merge and
 * continue), else the base branch once the PR is merged (the commit slop doesn't record for a normal merge, and a branch moves),
 * else the PR head.
 */
const scriptRef = (glob: GlobView, baseBranch: string | null): string | null => {
  const merged = glob.prs.at(-1)?.mergeSha;
  if (merged !== undefined) return merged;
  return glob.pr?.state === 'merged' ? baseBranch : (glob.pr?.headSha ?? glob.id);
};

/** Where a repo script lives on GitHub: the board's repo and base branch. */
interface ScriptSource {
  readonly repo: string | null;
  readonly baseBranch: string | null;
}

interface StepActions {
  /** Each resolves false when the request failed (the page says why). */
  readonly onAdd: (step: { title: string; detail?: string; who?: string; due?: string }) => Promise<boolean>;
  readonly onComplete: (stepId: string) => Promise<boolean>;
  readonly onDismiss: (stepId: string, reason: string) => Promise<boolean>;
}

const Step = ({ glob, step, mine, busy, actions, source }: { glob: GlobView; step: ListedHumanStep; mine: boolean; busy: boolean; actions: StepActions; source: ScriptSource }) => {
  const [dismissing, setDismissing] = useState(false);
  const predicted = step.predicted === true;
  const work = isWorkStep(step);
  const open = step.state === 'due' || step.state === 'pending';
  return (
    <li
      className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded border p-2 text-xs', mine && step.state === 'due' && 'border-foreground')}
      data-testid='human-step'
      data-state={step.state}
      data-kind={step.kind}
      data-predicted={predicted ? 'true' : undefined}
    >
      <div className='flex flex-wrap items-center gap-2'>
        {work && !predicted && (
          <input
            type='checkbox'
            aria-label={`Done: ${stripMarkdown(step.title)}`}
            data-testid='step-tick'
            checked={step.state === 'done'}
            disabled={busy || !open}
            onChange={() => void actions.onComplete(step.id)}
          />
        )}
        <HumanIcon decorative />
        <span className={cn('min-w-0 break-words font-medium [overflow-wrap:anywhere]', (step.state === 'dismissed' || step.state === 'done' || predicted) && 'text-muted-foreground', (step.state === 'dismissed' || step.state === 'done') && 'line-through')} data-testid='step-title'>
          {predicted ? PREDICTED_ROLLOUT_TEXT : stripMarkdown(step.title)}
        </span>
        <span className='font-mono text-[11px] text-muted-foreground'>{step.kind.replace(/_/g, ' ')}</span>
        {mine && !predicted && step.state === 'due' && <span className='rounded-sm bg-foreground px-1 font-mono text-[10px] text-background'>Your turn</span>}
      </div>
      <div className='flex flex-wrap gap-x-3 break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]'>
        <span data-testid='step-who'>for {whoText(step.who)}</span>
        <span data-testid='step-state'>{stateText(step)}</span>
        {step.check != null && step.check !== '' && <span data-testid='step-check'>checked by slop: {step.check}</span>}
      </div>
      {step.detail != null && step.detail !== '' && <StepDetail detail={step.detail} />}
      <StepFields glob={glob} step={step} source={source} showDetail={false} />
      {work && open && !dismissing && (
        <button type='button' className='justify-self-start text-[11px] underline' data-testid='step-dismiss' onClick={() => setDismissing(true)}>
          Dismiss
        </button>
      )}
      {dismissing && <DismissForm busy={busy} onDismiss={(text) => actions.onDismiss(step.id, text)} onClose={() => setDismissing(false)} />}
    </li>
  );
};

/** One command in a monospace box with a copy button; `extra` sits beside the button (a link to the script's file). */
const CommandBox = ({
  command,
  extra,
  testId = 'step-command',
  copyId = 'step-command-copy',
  copyText,
}: {
  command: string;
  extra?: ReactNode;
  testId?: string;
  copyId?: string;
  copyText?: () => Promise<string>;
}) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = copyText === undefined ? command : await copyText();
    setCopied(
      await copyOrSelect(
        text,
        typeof navigator === 'undefined' ? undefined : navigator.clipboard,
        () => undefined,
      ),
    );
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded border bg-muted p-1.5 text-[11px]">
      <code className="min-w-0 grow break-all font-mono" data-testid={testId}>
        {command}
      </code>
      <Button size="sm" variant="outline" data-testid={copyId} onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {extra}
    </div>
  );
};

/** A step's script: the command to run (or the link to its artifact), a copy button and a link to the file. */
const ScriptRow = ({
  glob,
  script,
  source,
}: {
  glob: GlobView;
  script: HumanStepScript;
  source: ScriptSource;
}) => {
  if ('path' in script) {
    const sourceUrl = scriptSourceUrl(source.repo, script.path, scriptRef(glob, source.baseBranch));
    return (
      <CommandBox
        command={scriptRunCommand(script.path)}
        testId="step-script-path"
        copyId="step-copy"
        extra={
          sourceUrl === null ? undefined : (
            <a
              className="underline"
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="step-script-source"
            >
              View script
            </a>
          )
        }
      />
    );
  }
  const copyText = () =>
    scriptCopyText(glob.boardId, glob.id, script, api.rolloutScript, window.location.origin);
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <Link
        className="min-w-0 break-words underline [overflow-wrap:anywhere]"
        to={scriptArtifactPath(glob.boardId, glob.id, script)}
        data-testid="step-script-link"
      >
        Rollout script: {script.artifact}
      </Link>
      <CopyButton copyText={copyText} />
    </div>
  );
};

const CopyButton = ({ copyText }: { copyText: () => Promise<string> }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid="step-copy"
      onClick={() =>
        void copyText()
          .then((text) =>
            copyOrSelect(
              text,
              typeof navigator === 'undefined' ? undefined : navigator.clipboard,
              () => undefined,
            ),
          )
          .then(setCopied)
      }
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
};

/** A labelled field of Markdown text: the label quiet, the text rendered (bold, code, code blocks with copy). */
const Field = ({ label, text, testId }: { label: string; text: string; testId: string }) => (
  <div className="min-w-0 break-words text-xs [overflow-wrap:anywhere]" data-testid={testId}>
    <span className="text-muted-foreground">{label}:</span>
    <MarkdownView content={text} bare />
  </div>
);

/**
 * What a step says, laid out from its fields, as Markdown, empty fields left out: Why; Before you start (the permissions);
 * Run (the script's run command once, then each command, every one in its own copyable box); Check it worked. The step's
 * free `detail` (anything the fields don't cover) shows as Markdown after Why when `showDetail`.
 */
const StepFields = ({
  glob,
  step,
  source,
  showDetail,
}: {
  glob: GlobView;
  step: ListedHumanStep;
  source: ScriptSource;
  showDetail: boolean;
}) => {
  const script = step.script ?? null;
  const commands = step.commands ?? [];
  const detail = step.detail?.trim() ?? '';
  const why = step.why?.trim() ?? '';
  const permissions = step.permissions?.trim() ?? '';
  const verify = step.verify?.trim() ?? '';
  return (
    <>
      {why !== '' && <Field label="Why" text={why} testId="step-why" />}
      {showDetail && detail !== '' && (
        <StepDetail detail={detail} />
      )}
      {permissions !== '' && (
        <Field label="Before you start" text={permissions} testId="step-permissions" />
      )}
      {(script !== null || commands.length > 0) && (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1" data-testid="step-run">
          <span className="text-[11px] text-muted-foreground">Run</span>
          {script !== null && <ScriptRow glob={glob} script={script} source={source} />}
          {commands.map((command, i) => (
            <CommandBox key={`${String(i)}:${command}`} command={command} />
          ))}
        </div>
      )}
      {verify !== '' && <Field label="Check it worked" text={verify} testId="step-verify" />}
    </>
  );
};

/** The reason form a dismissal needs; resolves its reason through `onDismiss` and closes when that went through. */
const DismissForm = ({ busy, onDismiss, onClose }: { busy: boolean; onDismiss: (reason: string) => Promise<boolean>; onClose: () => void }) => {
  const [reason, setReason] = useState('');
  const reasonText = dismissReason(reason);
  return (
    <form
      className='flex flex-wrap items-end gap-2'
      onSubmit={(e) => {
        e.preventDefault();
        if (reasonText === null) return;
        void onDismiss(reasonText).then((ok) => {
          if (ok) onClose();
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
      <Button size='sm' type='button' variant='ghost' onClick={onClose}>
        Cancel
      </Button>
    </form>
  );
};

/**
 * A due step as a full card in the top block: title, who, the step's text as Markdown (Why / Do this / Permissions / Check it
 * worked), the script's command with a copy button, and Done and Dismiss…. A step slop ticks itself (a capability check) has Done disabled with why.
 */
const DueStep = ({ glob, step, mine, busy, actions, source }: { glob: GlobView; step: ListedHumanStep; mine: boolean; busy: boolean; actions: StepActions; source: ScriptSource }) => {
  const [dismissing, setDismissing] = useState(false);
  const waits = step.check != null && step.check !== '';
  return (
    <li className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded border bg-background p-3 text-sm' data-testid='due-step' data-kind={step.kind}>
      <div className='flex flex-wrap items-center gap-2'>
        <HumanIcon decorative />
        <span className='min-w-0 break-words font-medium [overflow-wrap:anywhere]' data-testid='step-title'>
          {stripMarkdown(step.title)}
        </span>
        <span className='font-mono text-[11px] text-muted-foreground'>{step.kind.replace(/_/g, ' ')}</span>
        {mine && <span className='rounded-sm bg-foreground px-1 font-mono text-[10px] text-background'>Your turn</span>}
      </div>
      <span className='text-xs text-muted-foreground' data-testid='step-who'>
        for {whoText(step.who)}
      </span>
      <StepFields glob={glob} step={step} source={source} showDetail />
      {waits && (
        <span className='text-[11px] text-muted-foreground' data-testid='step-check'>
          waits for {step.check} to turn on; slop ticks this itself
        </span>
      )}
      {!dismissing && (
        <div className='flex flex-wrap gap-2'>
          <Button size='sm' disabled={busy || waits} data-testid='due-done' onClick={() => void actions.onComplete(step.id)}>
            Done
          </Button>
          <Button size='sm' variant='outline' disabled={busy} data-testid='due-dismiss' onClick={() => setDismissing(true)}>
            Dismiss…
          </Button>
        </div>
      )}
      {dismissing && <DismissForm busy={busy} onDismiss={(text) => actions.onDismiss(step.id, text)} onClose={() => setDismissing(false)} />}
    </li>
  );
};

/** Steps not yet due behind one quiet line ("2 steps after merge"), collapsed until asked for. */
const QuietSteps = ({ steps, render }: { steps: readonly ListedHumanStep[]; render: (step: ListedHumanStep) => ReactNode }) => {
  const [shown, setShown] = useState(false);
  if (steps.length === 0) return null;
  return (
    <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-[11px] text-muted-foreground' data-testid='quiet-steps'>
      <button type='button' className='justify-self-start' aria-expanded={shown} data-testid='quiet-toggle' onClick={() => setShown(!shown)}>
        {quietText(steps)} {shown ? '▾' : '▸'}
      </button>
      {shown && <ul className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2'>{steps.map(render)}</ul>}
    </div>
  );
};

/** Dismissed steps behind one quiet line, collapsed until asked for; read-only. */
const DismissedSteps = ({ steps }: { steps: readonly ListedHumanStep[] }) => {
  const [shown, setShown] = useState(false);
  if (steps.length === 0) return null;
  return (
    <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-[11px] text-muted-foreground' data-testid='dismissed-steps'>
      <button type='button' className='justify-self-start' aria-expanded={shown} data-testid='dismissed-toggle' onClick={() => setShown(!shown)}>
        {steps.length} dismissed {shown ? '▾' : '▸'}
      </button>
      {shown && (
        <ul className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1'>
          {steps.map((s) => (
            <li key={s.id} className='min-w-0 break-words [overflow-wrap:anywhere]' data-testid='dismissed-step'>
              <span className='line-through' data-testid='dismissed-title'>
                {stripMarkdown(s.title)}
              </span>
              <span data-testid='dismissed-reason'>
                {s.dismissedReason == null || s.dismissedReason === '' ? null : (
                  <>
                    : <InlineMarkdown text={s.dismissedReason} />
                  </>
                )}
              </span>
              {dismissalText(s) !== '' && <span data-testid='dismissed-who'> ({dismissalText(s)})</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
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
  repo = null,
  baseBranch = null,
  startOpen = false,
  openSignal = 0,
  collapsed = false,
  part = 'all',
  ...actions
}: {
  glob: GlobView;
  viewer?: HumanStepViewer;
  canAdd: boolean;
  /** The board's repo and base branch, for a script step's link to its file on GitHub. */
  repo?: string | null;
  baseBranch?: string | null;
  /** A `section=human-steps` link opens it. */
  startOpen?: boolean;
  /** Bumped by the main button: opens the section again if the viewer collapsed it. */
  openSignal?: number;
  /** Starts collapsed whatever is still to do (a decision glob: the steps sit below the assessments). */
  collapsed?: boolean;
  /** `due` is the block of due steps above the action row; `rest` is the collapsible section with the other steps and Add step; `all` is both, one after the other. */
  part?: 'due' | 'rest' | 'all';
} & StepActions) => {
  const all = glob.humanSteps ?? [];
  const live = all.filter((s) => !isDismissedStep(s));
  const due = dueWorkSteps(live);
  const quiet = live.filter(isQuietStep);
  const steps = live.filter((s) => !due.includes(s) && !quiet.includes(s));
  const dismissed = all.filter(isDismissedStep);
  const [toggled, setToggled] = useState<boolean | null>(() => (startOpen ? true : collapsed ? false : readStepsOpen()));
  const stepsOpenByDefault = defaultStepsOpen([...steps, ...quiet]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (openSignal > 0) setToggled(true);
  }, [openSignal]);
  const showDue = part !== 'rest' && due.length > 0;
  const showRest = part !== 'due' && (canAdd || steps.length + quiet.length + dismissed.length > 0);
  if (!showDue && !showRest) return null;
  const open = toggled ?? stepsOpenByDefault;
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
  const left = steps.filter((s) => (s.state === 'due' || s.state === 'pending') && s.predicted !== true).length;
  const stepProps = (s: ListedHumanStep) => ({ glob, source: { repo, baseBranch }, step: s, mine: viewer !== undefined && isForViewer(s, glob, viewer), busy, actions: wrapped });
  return (
    <section className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2' aria-label='Human steps' data-testid='human-steps'>
      {showDue && (
        <Block
          tone='person'
          actor='human'
          testId='due-steps'
          title={due.length === 1 ? 'A step needs you' : `${String(due.length)} steps need you`}
        >
          <ul className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2'>
            {due.map((s) => (
              <DueStep key={s.id} {...stepProps(s)} />
            ))}
          </ul>
        </Block>
      )}
      {showRest && (
        <>
          <div className='flex items-center gap-2'>
            <SectionToggle open={open} onToggle={toggle} testId='human-steps-toggle'>
              {due.length > 0 ? 'More steps' : 'Human steps'} ({steps.length + quiet.length})
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
                    <Step key={s.id} {...stepProps(s)} />
                  ))}
                </ul>
              )}
              <QuietSteps steps={quiet} render={(s) => <Step key={s.id} {...stepProps(s)} />} />
              <DismissedSteps steps={dismissed} />
              {canAdd && adding && <AddStep busy={busy} onAdd={wrapped.onAdd} onClose={() => setAdding(false)} />}
            </>
          )}
        </>
      )}
    </section>
  );
};
