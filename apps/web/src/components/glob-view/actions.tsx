import { decisionOf, machine } from '@slop/core';
import type { Action, EditFailure, Handover } from '@slop/core';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { actionTiers, orderActions } from '@/lib/action-style';
import { actionPresentation, presentedActions } from '@/lib/action-presentation';
import { mainAction, promotedAction } from '@/lib/main-action';
import { mainStep, scriptCopyText, stepMain } from '@/lib/human-steps';
import { api } from '@/lib/api';
import { copyOrSelect } from '@/lib/plan-text';
import { takeOverConfirmation } from '@/lib/sstor-command';
import { ActorIcon, HumanIcon } from '@/components/actor-icons';
import { findSection } from '@/lib/glob-scroll';
import { workingLabel } from '@/lib/card-pending';
import { PENDING_TIMEOUT_MS, isPending, startAction } from '@/lib/pending-action';
import type { PendingAction } from '@/lib/pending-action';
import { startAgainConfirmation } from '@/lib/start-again';
import { handoverConfirmation, handoverOneLine, handoverToShow } from '@/lib/handover';
import { handoverKey, isDismissed } from '@/lib/dismissals';
import { chainTip, mergeWarning, waitingFor } from '@/lib/status-line';
import { typeOptions } from '@/lib/type-change';
import type { TypeOption } from '@/lib/type-change';
import { isOversized } from '../oversized-glob';
import type { OversizedState } from '../oversized-glob';
import { Tip } from '../ui/tip';
import { TypePopover } from '../type-popover';
import type { GlobViewContext } from './context';
import { splittable } from './size';

/**
 * The state the actions, the type chip and the reset area share: what is running, which confirmation is
 * open, and the glob's available actions. `GlobDetail` owns it (the other sections need `busy` and `run`);
 * the components below read it.
 */
export const useGlobActions = ({
  board,
  glob,
  onAction,
  onUpdate,
  onDismiss,
  onCompleteStep,
  email,
}: Pick<GlobViewContext, 'board' | 'glob' | 'onAction' | 'onUpdate'> & {
  /** Ticks a work step (the main button of a due rollout step); resolves false when it failed. */
  onCompleteStep?: (stepId: string) => Promise<boolean>;
  /** "Got it" / ×, and "Show again": stores the viewer's dismissal of a status message; resolves false when it failed. */
  onDismiss: (key: string, dismiss: boolean) => Promise<boolean>;
  /** Who is looking, for the steps that are theirs (unknown until /api/me has answered). */
  email?: string;
}) => {
  // A decision glob has no branch, PR, runs, deploys or labels: those parts of the view are left out.
  const decision = decisionOf(glob) !== null;
  const [running, setBusy] = useState(false);
  // An action stays pending until the glob has moved (its version changes), not just until the request returns.
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending === null) return undefined;
    const timer = setTimeout(
      () => setNow(Date.now()),
      PENDING_TIMEOUT_MS - (Date.now() - pending.at) + 50,
    );
    return () => clearTimeout(timer);
  }, [pending]);
  const pendingNow = isPending(pending, glob, Math.max(now, pending?.at ?? 0));
  const busy = running || pendingNow;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmingRetrigger, setConfirmingRetrigger] = useState(false);
  // The type chip's popover says what follows before it changes the type.
  const [typeFailure, setTypeFailure] = useState<EditFailure | null>(null);
  const typeChoices = typeOptions(glob, board.role);
  const changeType = async (option: TypeOption) => {
    setTypeFailure(null);
    if (option.via === 'update') {
      setTypeFailure(await onUpdate({ type: option.to }));
    } else if (option.via !== null && !(await onAction(option.via))) {
      setTypeFailure({ message: `Could not make it a ${option.to}`, conflict: false });
    }
  };
  const oversized = isOversized(glob);
  // Starting a flagged glob asks first: it is likely more than one PR's worth of work.
  const [confirmingOversized, setConfirmingOversized] = useState<Action | null>(null);
  // Discard throws the PR and branch away, so it says what it will do first.
  const [confirmingAgain, setConfirmingAgain] = useState(false);
  // Pick up from a live machine run stops it: say what happens and the command to run first.
  const [confirmingTakeOver, setConfirmingTakeOver] = useState(false);
  // A super's local review normally comes first (/finalise); the board warns, then allows.
  const [confirmingReady, setConfirmingReady] = useState(false);
  // Done changes nothing until GitHub confirms, so say it was asked for meanwhile.
  const [readyAsked, setReadyAsked] = useState(false);
  // "Why you're needed": the full box until the viewer acknowledges it, then one line.
  const brief = handoverToShow(glob);
  const briefRead = brief !== null && isDismissed(glob, handoverKey(brief));
  const [briefOpen, setBriefOpen] = useState(false);
  useEffect(() => {
    setConfirmingAgain(false);
    setConfirmingTakeOver(false);
    setTypeFailure(null);
    setConfirmingOversized(null);
    setBriefOpen(false);
  }, [glob.id]);
  // Dismissing a message is stored per person on the server; the page reloads the glob afterwards.
  const dismiss = (key: string, on: boolean) =>
    run(async () => {
      await onDismiss(key, on);
    });

  // deescalate and make_super are reached through the type popover.
  const shownActions = presentedActions(glob.allowedActions ?? []).filter(
    (a) => a !== 'delete' && actionPresentation(a, glob, false, email).placement !== 'none',
  );
  // Decide has its own panel with the five outcomes: it can be the main button (which goes to
  // the panel), never a More entry.
  const allActions = shownActions.filter((a) => a !== 'decide');
  const viewer = email === undefined ? undefined : { email, role: board.role };
  // A due blocking step for the viewer (a rollout) is the next thing to do, ahead of the state's next step but not a recovery.
  const stepTurn = mainStep(glob, viewer);
  const [stepsSignal, setStepsSignal] = useState(0);
  // A stalled glob's step names the one action to lead with and one alternative to follow it.
  const stall = glob.humanSteps?.find((s) => s.kind === 'unstick');
  const leading =
    stall?.action === undefined || stall.action === 'open_session' ? undefined : stall.action;
  // With no natural main (and no due step) a menu item is promoted, so the ▾ never stands alone.
  const natural = mainAction(shownActions, glob, decision, stepTurn !== null, email, leading);
  const main = natural ?? (stepTurn === null ? promotedAction(allActions) : null);
  const actions = orderActions(allActions, main, stall?.alternative);
  const tiers = actionTiers(allActions, main);
  const disabled = waitingFor(glob, actions, board.role);
  const readyPending = readyAsked && glob.status === 'in_progress' && glob.pr?.state === 'draft';
  const reviewedAtHead = (glob.artifacts ?? []).some(
    (a) => a.kind === 'local_review' && machine.sameCommit(a.commitSha, glob.pr?.headSha),
  );
  const markReady = () =>
    run(async () => {
      setConfirmingReady(false);
      if (await onAction('mark_ready')) setReadyAsked(true);
    });

  const begin = (action: Action) => {
    if (action === 'decide') {
      // The outcome buttons, not the first button in the section (a retry, an expand toggle).
      const panel = findSection(document, 'decision');
      const target =
        panel?.querySelector<HTMLElement>(
          '[data-testid="outcomes"], [data-testid="replacement-outcomes"]',
        ) ?? panel;
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
      return;
    }
    if (action === 'mark_ready') {
      if (reviewedAtHead) void markReady();
      else setConfirmingReady(true);
      return;
    }
    if (action === 'start_again') {
      setConfirmingAgain(true);
      return;
    }
    if (action === 'take_over') {
      setConfirmingTakeOver(true);
      return;
    }
    if (action === 'retrigger' && (glob.blockedBy?.length ?? 0) > 0) {
      setConfirmingRetrigger(true);
      return;
    }
    // Resume reopens your own session: nothing starts, so there is nothing to confirm.
    const resuming =
      action === 'pick_up' && glob.implementer !== null && glob.implementer === email;
    if (
      !resuming &&
      ((oversized && (action === 'start' || action === 'start_anyway' || action === 'pick_up')) ||
        (brief !== null && (action === 'start_anyway' || action === 'pick_up')))
    ) {
      setConfirmingOversized(action);
      return;
    }
    void startAction(
      pending,
      running,
      { action, version: glob.version, at: Date.now() },
      glob,
      () => onAction(action),
      setPending,
    );
  };

  return {
    decision,
    busy,
    run,
    pending,
    begin,
    main,
    viewer,
    stepTurn,
    stepsSignal,
    setStepsSignal,
    actions,
    tiers,
    disabled,
    typeChoices,
    typeFailure,
    changeType,
    oversized,
    brief,
    briefRead,
    dismiss,
    briefOpen,
    setBriefOpen,
    confirmDelete,
    setConfirmDelete,
    confirmingAgain,
    setConfirmingAgain,
    confirmingTakeOver,
    setConfirmingTakeOver,
    confirmingRetrigger,
    setConfirmingRetrigger,
    confirmingOversized,
    setConfirmingOversized,
    confirmingReady,
    setConfirmingReady,
    readyPending,
    markReady,
    completeStep: onCompleteStep,
  };
};

export type GlobActionsState = ReturnType<typeof useGlobActions>;

/** Merge also warns when the base moved since the checks ran (slop merges it first). */
const tipOf = (action: Action, glob: GlobViewContext['glob'], email?: string) => {
  const tip = actionPresentation(action, glob, false, email).tip;
  const warning = action === 'merge' ? mergeWarning(glob) : null;
  return warning === null ? tip : `${tip}\n${warning}`;
};

const ActionContent = ({
  action,
  ctx,
  state,
}: {
  action: Action;
  ctx: GlobViewContext;
  state: GlobActionsState;
}) => {
  const shown = actionPresentation(action, ctx.glob, false, state.viewer?.email);
  return state.busy && state.pending?.action === action ? (
    <>
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      {workingLabel(action)}
    </>
  ) : (
    <>
      <ActorIcon actor={shown.icon} decorative />
      {shown.label}
    </>
  );
};

/** The type chip in the header: its popover says what follows before it changes the type. */
export const TypeChip = ({ ctx, state }: { ctx: GlobViewContext; state: GlobActionsState }) => (
  <TypePopover
    type={ctx.glob.type}
    options={state.typeChoices}
    busy={state.busy}
    failure={state.typeFailure}
    onChange={(option) => state.run(() => state.changeType(option))}
  />
);

const CLAMP_AT = 200;

/** A long line (a run's whole failure reason) cut to its first lines, with a toggle for the rest. */
const Clamped = ({ text }: { text: string }) => {
  const [more, setMore] = useState(false);
  if (text.length <= CLAMP_AT) return <>{text}</>;
  return (
    <>
      {more ? text : `${text.slice(0, CLAMP_AT).trimEnd()}…`}{' '}
      <button
        type="button"
        className="cursor-pointer text-xs underline"
        data-testid="clamp-toggle"
        onClick={() => setMore(!more)}
      >
        {more ? 'show less' : 'show more'}
      </button>
    </>
  );
};

/** Why the viewer is needed, inside the Now panel's details: the full brief until acknowledged, then one line. */
export const HandoverBrief = ({
  state,
  brief,
  omit = [],
}: {
  state: GlobActionsState;
  brief: Handover;
  /** Lines the panel already shows elsewhere (the failure, the decision), left out so each fact appears once. */
  omit?: readonly string[];
}) => {
  const { briefRead, briefOpen } = state;
  const why = brief.why.filter((line) => !omit.includes(line));
  const detail = brief.detail.filter((line) => !omit.includes(line));
  return (
    <div
      className="grid gap-1 rounded border border-amber/60 bg-amber/10 p-2 text-sm"
      data-testid="handover-box"
    >
      {briefRead && !briefOpen ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1">
            <strong>Why you're needed:</strong> {handoverOneLine(brief)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            data-testid="handover-expand"
            onClick={() => state.setBriefOpen(true)}
          >
            Show
          </Button>
        </div>
      ) : (
        <>
          <strong>Why you're needed</strong>
          <ul className="list-disc pl-5">
            {why.map((cause) => (
              <li key={cause}>
                <Clamped text={cause} />
              </li>
            ))}
          </ul>
          <p>
            <strong>First:</strong> {brief.next}
          </p>
          {detail.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {detail.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <div>
            <Button
              size="sm"
              variant="ghost"
              data-testid="handover-acknowledge"
              onClick={() => {
                void state.dismiss(handoverKey(brief), true);
                state.setBriefOpen(false);
              }}
            >
              Got it
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

/**
 * A due blocking step as the glob's main button: Copy rollout command for a script (then Mark done), Mark done for a
 * setting or manual step with its text beside it, and disabled with the reason when slop ticks it itself.
 */
const StepMainButton = ({
  step,
  glob,
  busy,
  onComplete,
  menu,
}: {
  step: NonNullable<ReturnType<typeof mainStep>>['step'];
  glob: GlobViewContext['glob'];
  busy: boolean;
  onComplete: ((stepId: string) => Promise<boolean>) | undefined;
  /** The ▾ of the split button, joined to the button. */
  menu?: ReactNode;
}) => {
  const main = stepMain(step);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [step.id]);
  const copy = async () => {
    const text = await scriptCopyText(
      glob.boardId,
      glob.id,
      step.script ?? { path: '' },
      api.rolloutScript,
      window.location.origin,
    );
    setCopied(
      await copyOrSelect(
        text,
        typeof navigator === 'undefined' ? undefined : navigator.clipboard,
        () => undefined,
      ),
    );
  };
  const tick = () => void onComplete?.(step.id);
  const asCopy = main.kind === 'copy' && !copied;
  const label = main.kind === 'copy' ? (copied ? main.then : main.label) : main.label;
  const unavailable = main.kind === 'wait' || (!asCopy && onComplete === undefined);
  return (
    <>
      <div className="inline-flex">
        <Tip text={main.kind === 'wait' ? main.reason : step.title}>
          <span>
            <Button
              size="sm"
              className={menu === undefined ? undefined : 'rounded-r-none'}
              data-testid="main-action"
              data-step={step.id}
              data-step-action={main.kind === 'wait' ? 'wait' : asCopy ? 'copy' : 'done'}
              disabled={busy || unavailable}
              onClick={asCopy ? () => void copy() : tick}
            >
              <HumanIcon decorative />
              {label}
            </Button>
          </span>
        </Tip>
        {menu}
      </div>
      <span className="text-xs text-muted-foreground" data-testid="main-action-note">
        {main.kind === 'wait'
          ? `${step.title}: ${main.reason}`
          : main.kind === 'done' && main.text !== null
            ? `${step.title}: ${main.text}`
            : step.title}
      </span>
    </>
  );
};

/** Pick up from a live machine run: what happens to the run and the branch, and the command that carries on. */
const TakeOverConfirmation = ({
  ctx,
  state,
}: {
  ctx: GlobViewContext;
  state: GlobActionsState;
}) => {
  const says = takeOverConfirmation(ctx.glob);
  const [copied, setCopied] = useState(false);
  const copy = async () =>
    setCopied(
      await copyOrSelect(
        says.command,
        typeof navigator === 'undefined' ? undefined : navigator.clipboard,
        () => undefined,
      ),
    );
  return (
    <div
      role="alertdialog"
      aria-label={says.title}
      data-testid="take-over-confirmation"
      className="grid gap-2 rounded border border-amber/60 bg-amber/10 p-3 text-xs"
    >
      <strong>{says.title}</strong>
      <p data-testid="take-over-happens">{says.happens}</p>
      {state.oversized && (
        <p data-testid="take-over-oversized">
          This glob is flagged oversized: it is probably more than one PR&apos;s worth of work.
        </p>
      )}
      {state.brief !== null && (
        <p data-testid="handover-confirmation">{handoverConfirmation('take_over', state.brief)}</p>
      )}
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-muted px-2 py-1" data-testid="take-over-command">
          {says.command}
        </code>
        <Button
          size="sm"
          variant="outline"
          data-testid="take-over-copy"
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p>{says.how}</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => state.setConfirmingTakeOver(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={state.busy}
          data-testid="confirm-take-over"
          onClick={() =>
            void state.run(async () => {
              state.setConfirmingTakeOver(false);
              await ctx.onAction('take_over');
            })
          }
        >
          Pick up
        </Button>
      </div>
    </div>
  );
};

/** A split move: not a machine action, so it has no presentation entry; it opens the split form or calls the size check. */
interface SplitMove {
  id: 'split-as-proposed' | 'split' | 'edit-split' | 'propose-split' | 'keep-whole';
  label: string;
  tip: string;
  run: () => void;
}

const SPLIT_TIP =
  'Cut this glob into parts: part 1 stays here, the others are created with their share of the plan';

/**
 * The split moves for the glob: Split… in the menu of a splittable glob; on an oversized one Split as proposed (or Split…
 * when nothing was proposed) leads, and Edit split, Propose again and Keep whole head the menu.
 */
const splitMoves = (
  ctx: GlobViewContext,
  state: GlobActionsState,
  size: OversizedState,
  onSplitting: (splitting: boolean) => void,
): { lead: SplitMove | null; menu: SplitMove[] } => {
  const { glob, board } = ctx;
  const open = () => onSplitting(true);
  if (state.decision) return { lead: null, menu: [] };
  if (!state.oversized)
    return {
      lead: null,
      menu: splittable(glob, state.decision)
        ? [{ id: 'split', label: 'Split…', tip: SPLIT_TIP, run: open }]
        : [],
    };
  // The proposal comes with the single-glob read: until it is here there is nothing to lead with. If the read failed,
  // the glob is treated as having no proposal, so splitting by hand and Keep whole stay possible.
  if (size.check === undefined && !size.loadFailed) return { lead: null, menu: [] };
  const canKeep = board.role !== 'qa' || glob.type === 'sub';
  const hasProposal = size.proposal !== null;
  const menu: SplitMove[] = [];
  if (hasProposal)
    menu.push({
      id: 'edit-split',
      label: 'Edit split',
      tip: 'Open the split form, pre-filled with the proposal',
      run: open,
    });
  if (size.check !== undefined)
    menu.push({
      id: 'propose-split',
      label: size.proposing ? 'Proposing…' : hasProposal ? 'Propose again' : 'Propose split',
      tip: 'Ask slop for a new proposed split',
      run: size.proposeAgain,
    });
  if (canKeep)
    menu.push({
      id: 'keep-whole',
      label: 'Keep whole',
      tip: 'Keep it as one glob; slop learns from how it goes',
      run: () => size.setConfirmingKeep(true),
    });
  const lead: SplitMove = hasProposal
    ? {
        id: 'split-as-proposed',
        label: 'Split as proposed',
        tip: 'Cut it into the proposed parts: part 1 stays here, the others are created with their share of the plan',
        run: () => void size.splitAsProposed(),
      }
    : { id: 'split', label: 'Split…', tip: SPLIT_TIP, run: open };
  return { lead, menu };
};

/** The `actions` section's content: the handover box, the main button, More ▾ and the confirmations. */
export const GlobActions = ({
  ctx,
  state,
  size,
  onSplitting,
}: {
  ctx: GlobViewContext;
  state: GlobActionsState;
  size: OversizedState;
  onSplitting: (splitting: boolean) => void;
}) => {
  const { glob } = ctx;
  const { pending, stepTurn, actions, tiers, disabled, brief, oversized } = state;
  const busy = state.busy || size.busy;
  const moves = splitMoves(ctx, state, size, onSplitting);
  // A due step still leads; otherwise an oversized glob's split leads and the action that would have moves into the menu.
  const lead = stepTurn === null ? moves.lead : null;
  const main = lead === null ? state.main : null;
  const moreActions = actions.filter((a) => a !== main && tiers.get(a) !== 'destructive');
  // The menu closes on select, so the More button shows the action it started while it runs.
  const moreRunning =
    busy && pending !== null && moreActions.includes(pending.action) ? pending.action : null;
  const moveRunning = size.busy || size.proposing;
  const { confirmingOversized } = state;
  // The ▾ only ever joins a main button: with none (no allowed action to promote) the row shows nothing.
  const hasMain = main !== null || stepTurn !== null || lead !== null;
  const hasMenu = hasMain && moves.menu.length + moreActions.length + disabled.length > 0;
  const menu = hasMenu ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          className="rounded-l-none border-l-primary-foreground/40 px-1.5"
          disabled={busy}
          aria-label="More actions"
          data-testid="more-actions"
        >
          {moreRunning === null && !moveRunning ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <Loader2
              className="size-3.5 animate-spin"
              aria-label={moreRunning === null ? 'Working' : workingLabel(moreRunning)}
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="more-menu">
        {moves.menu.map((move) => (
          <DropdownMenuItem
            key={move.id}
            disabled={move.id === 'propose-split' && size.proposing}
            data-testid={`more-${move.id}`}
            onSelect={move.run}
          >
            <span className="flex items-center gap-1.5 font-medium">
              <HumanIcon decorative />
              {move.label}
            </span>
            <span className="text-xs text-muted-foreground">{move.tip}</span>
          </DropdownMenuItem>
        ))}
        {moreActions.map((action) => {
          const shown = actionPresentation(action, glob, false, state.viewer?.email);
          return (
            <DropdownMenuItem
              key={action}
              data-testid={`more-${action}`}
              onSelect={() => state.begin(action)}
            >
              <span className="flex items-center gap-1.5 font-medium">
                <ActorIcon actor={shown.icon} decorative />
                {shown.label}
              </span>
              <span className="whitespace-pre-line text-xs text-muted-foreground">
                {tipOf(action, glob, state.viewer?.email)}
              </span>
            </DropdownMenuItem>
          );
        })}
        {disabled.map(({ action, label, icon, tip }) => (
          <DropdownMenuItem key={action} disabled>
            <span className="flex items-center gap-1.5 font-medium">
              <ActorIcon actor={icon} decorative />
              {label}
            </span>
            <span className="text-xs text-muted-foreground">{tip}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : undefined;
  return (
    <>
      {hasMain && (
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2" data-testid="glob-actions">
            {main === null && stepTurn !== null && (
              <StepMainButton
                step={stepTurn.step}
                glob={glob}
                busy={busy}
                onComplete={state.completeStep}
                menu={menu}
              />
            )}
            {lead !== null && (
              <div className="inline-flex" data-testid="split-button">
                <Tip text={lead.tip}>
                  <Button
                    size="sm"
                    className={hasMenu ? 'rounded-r-none' : undefined}
                    disabled={busy}
                    data-testid="main-action"
                    data-move={lead.id}
                    onClick={lead.run}
                  >
                    {size.busy ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <HumanIcon decorative />
                    )}
                    {lead.label}
                  </Button>
                </Tip>
                {menu}
              </div>
            )}
            {main !== null && (
              <div className="inline-flex" data-testid="split-button">
                <Tip text={tipOf(main, glob, state.viewer?.email)}>
                  <Button
                    size="sm"
                    className={hasMenu ? 'rounded-r-none' : undefined}
                    disabled={busy}
                    data-testid="main-action"
                    onClick={() => state.begin(main)}
                  >
                    <ActionContent action={main} ctx={ctx} state={state} />
                  </Button>
                </Tip>
                {menu}
              </div>
            )}
          </div>
          {state.confirmingReady && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
            >
              <span className="flex-1">
                No local review is recorded at the PR head: the change_reviewer and /finalise
                haven't run for {glob.pr?.headSha?.slice(0, 7) ?? 'the head'}. Mark it done anyway?
              </span>
              <Button size="sm" variant="ghost" onClick={() => state.setConfirmingReady(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void state.markReady()}
                data-testid="confirm-ready"
              >
                Done
              </Button>
            </div>
          )}
          {size.confirmingKeep && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
            >
              <span className="flex-1">Keep it as one glob? slop learns from how it goes.</span>
              <Button size="sm" variant="ghost" onClick={() => size.setConfirmingKeep(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy}
                data-testid="confirm-keep-whole"
                onClick={() => void size.keepWhole()}
              >
                Keep whole
              </Button>
            </div>
          )}
          {size.error !== null && (
            <p role="alert" className="text-xs text-red" data-testid="oversized-failure">
              {size.error}
            </p>
          )}
          {confirmingOversized !== null && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
            >
              <span className="flex-1" data-testid="oversized-start-says">
                {oversized &&
                  "This glob is flagged oversized: it is probably more than one PR's worth of work. Split it, or start it as it is?"}
                {brief !== null && (
                  <span data-testid="handover-confirmation">
                    {' '}
                    {handoverConfirmation(confirmingOversized, brief)}
                  </span>
                )}
              </span>
              <Button size="sm" variant="ghost" onClick={() => state.setConfirmingOversized(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy}
                data-testid="confirm-start-oversized"
                onClick={() =>
                  void state.run(async () => {
                    const action = confirmingOversized;
                    state.setConfirmingOversized(null);
                    await ctx.onAction(action);
                  })
                }
              >
                {oversized ? 'Start as it is' : 'Continue'}
              </Button>
            </div>
          )}
          {state.confirmingTakeOver && <TakeOverConfirmation ctx={ctx} state={state} />}
          {state.confirmingRetrigger && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
            >
              <span className="flex-1" data-testid="retrigger-says">
                Blocked by {chainTip(glob)}. A run now works without their changes.
              </span>
              <Button size="sm" variant="ghost" onClick={() => state.setConfirmingRetrigger(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy}
                data-testid="confirm-retrigger"
                onClick={() =>
                  void state.run(async () => {
                    state.setConfirmingRetrigger(false);
                    await ctx.onAction('retrigger', true);
                  })
                }
              >
                Retry anyway
              </Button>
            </div>
          )}
          {state.readyPending && (
            <p role="status" className="text-xs text-muted-foreground">
              Asked GitHub to mark PR #{glob.pr?.number} ready; the glob moves to PR open when
              GitHub confirms.
            </p>
          )}
        </div>
      )}
    </>
  );
};

/** The reset area: Discard & start again (with its confirmation) and Delete. */
export const GlobReset = ({
  ctx,
  state,
  onDelete,
}: {
  ctx: GlobViewContext;
  state: GlobActionsState;
  onDelete: () => Promise<void>;
}) => {
  const { board, glob } = ctx;
  const { busy, tiers, actions } = state;
  const resetActions = actions.filter((a) => tiers.get(a) === 'destructive' && a !== 'delete');
  return (
    <div className="grid gap-2 rounded border border-destructive/50 p-3" data-testid="reset-area">
      <div className="text-xs font-medium text-destructive">Reset</div>
      <div className="flex flex-wrap gap-2">
        {resetActions.map((action) => (
          <Tip key={action} text={tipOf(action, glob)}>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              data-testid={`reset-${action}`}
              onClick={() => state.begin(action)}
            >
              <ActionContent action={action} ctx={ctx} state={state} />
            </Button>
          </Tip>
        ))}
        {!state.confirmDelete && (
          <Button variant="danger" size="sm" onClick={() => state.setConfirmDelete(true)}>
            Delete…
          </Button>
        )}
      </div>
      {state.confirmingAgain && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
        >
          <span className="flex-1" data-testid="start-again-says">
            {startAgainConfirmation(glob, board.baseBranch)}
          </span>
          <Button size="sm" variant="ghost" onClick={() => state.setConfirmingAgain(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            data-testid="confirm-start-again"
            onClick={() =>
              void state.run(async () => {
                state.setConfirmingAgain(false);
                await ctx.onAction('start_again');
              })
            }
          >
            {actionPresentation('start_again', glob).label}
          </Button>
        </div>
      )}
      {state.confirmDelete && (
        <div className="grid gap-2 rounded border border-destructive/50 p-3 text-sm">
          <p>
            <strong>Delete {glob.id} permanently?</strong> This removes the glob, its branch, its
            PR, its artifacts and its events, so its time leaves the reports. There is no archive.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => state.setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void state.run(onDelete)}
            >
              Delete permanently
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
