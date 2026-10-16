import { decisionOf, isHumanCategory, machine } from '@slop/core';
import { isLearning } from '../decision-outcomes';
import type { Action, EditFailure } from '@slop/core';
import { useEffect, useState } from 'react';
import { ChevronDown, Ellipsis, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { actionTiers, orderActions } from '@/lib/action-style';
import { actionPresentation } from '@/lib/action-presentation';
import { mainVariant, promotedAction, viewActions, viewMainAction } from '@/lib/main-action';
import { mainStep } from '@/lib/human-steps';
import { blockingItem } from '@/lib/blocking-item';
import { takeOverConfirmation } from '@/lib/sstor-command';
import { ActorIcon, HumanIcon } from '@/components/actor-icons';
import { findSection } from '@/lib/glob-scroll';
import { workingLabel } from '@/lib/card-pending';
import { PENDING_TIMEOUT_MS, isPending, startAction } from '@/lib/pending-action';
import type { PendingAction } from '@/lib/pending-action';
import { startAgainConfirmation } from '@/lib/start-again';
import { handoverConfirmation, handoverToShow } from '@/lib/handover';
import { handoverKey, isDismissed } from '@/lib/dismissals';
import { blockedParts, chainTip, mergeWarning, waitingFor } from '@/lib/status-line';
import { typeOptions } from '@/lib/type-change';
import type { TypeOption } from '@/lib/type-change';
import { Tip } from '../ui/tip';
import { ArmSystemLabel } from '../glob-card';
import { armLabel } from '@/lib/rollout-stages';
import { META } from './tag-style';
import { Dot } from './status';
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
  // A decision glob has no branch, PR, runs, deploys or labels: those parts of the view are left out. Nor has an action.
  const decision = decisionOf(glob) !== null;
  const human = isHumanCategory(glob.category);
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
  // Taking over from a handover asks first.
  const [confirmingOversized, setConfirmingOversized] = useState<Action | null>(null);
  // Discard throws the PR and branch away, so it says what it will do first.
  const [confirmingAgain, setConfirmingAgain] = useState(false);
  // Pick up from a live machine run stops it: say what happens and the command to run first.
  const [confirmingTakeOver, setConfirmingTakeOver] = useState(false);
  // A super's local review normally comes first (/finalise); the board warns, then allows.
  const [confirmingReady, setConfirmingReady] = useState(false);
  // An action's Done asks for an optional note, and its Dismiss for a reason, before it ends the action.
  const [finishing, setFinishing] = useState<'complete_action' | 'dismiss_action' | null>(null);
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
    setFinishing(null);
  }, [glob.id]);
  // Dismissing a message is stored per person on the server; the page reloads the glob afterwards.
  const dismiss = (key: string, on: boolean) =>
    run(async () => {
      await onDismiss(key, on);
    });

  // deescalate and make_super are reached through the type popover.
  const shownActions = viewActions(glob, email);
  // Decide has its own panel with the five outcomes: it can be the main button (which goes to
  // the panel), never a More entry.
  const allActions = shownActions.filter((a) => a !== 'decide');
  const viewer = email === undefined ? undefined : { email, role: board.role };
  // A due blocking step for the viewer (a rollout) is the next thing to do, ahead of the state's next step but not a recovery.
  const stepTurn = mainStep(glob, viewer);
  const [stepsSignal, setStepsSignal] = useState(0);
  // A stalled glob's step names the one action to lead with and one alternative to follow it.
  const stall = glob.humanSteps?.find((s) => s.kind === 'unstick');
  // With no natural main (and no due step) a menu item is promoted, so the ▾ never stands alone.
  const natural = viewMainAction(glob, viewer);
  const main = natural ?? (stepTurn === null ? promotedAction(allActions, glob) : null);
  // A stalled glob's step (nobody moving it) makes Pick up the black main; while a sub's machine progresses it stays quiet.
  const variant = mainVariant(main, glob, stall !== undefined);
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
    if (action === 'complete_action' || action === 'dismiss_action') {
      setFinishing(action);
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
    if (action === 'retrigger' && blockedParts(glob) !== null) {
      setConfirmingRetrigger(true);
      return;
    }
    // Resume reopens your own session: nothing starts, so there is nothing to confirm.
    const resuming =
      action === 'pick_up' && glob.implementer !== null && glob.implementer === email;
    if (
      !resuming &&
      brief !== null &&
      (action === 'start_anyway' || action === 'pick_up')
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

  /** Ends the action glob: Done with the note, or Dismiss with the reason. */
  const finish = (action: 'complete_action' | 'dismiss_action', text: string) =>
    run(async () => {
      if (await onAction(action, undefined, text)) setFinishing(null);
    });

  return {
    decision,
    human,
    finishing,
    setFinishing,
    finish,
    busy,
    run,
    pending,
    begin,
    main,
    variant,
    viewer,
    /** The board's base branch, for the header's "merging from <base>". */
    base: board.baseBranch,
    stepsSignal,
    setStepsSignal,
    actions,
    tiers,
    disabled,
    typeChoices,
    typeFailure,
    changeType,
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

/** The type chip beside the group tag: its popover says what follows before it changes the type. */
export const TypeChip = ({ ctx, state }: { ctx: GlobViewContext; state: GlobActionsState }) =>
  ctx.glob.type === null ? null : (
    <TypePopover
      type={ctx.glob.type}
      options={state.typeChoices}
      busy={state.busy}
      failure={state.typeFailure}
      onChange={(option) => state.run(() => state.changeType(option))}
      compact
    />
  );

/**
 * Beside the action row (under it on narrow widths): the Arm system label and the branch, one quiet mono line.
 * Human work has no branch or deploy.
 */
const actionLine = ({ glob }: GlobViewContext) => {
  if (isHumanCategory(glob.category)) return null;
  const arming = armLabel(glob);
  return { arming };
};

const ActionLineInfo = ({ ctx, line }: { ctx: GlobViewContext; line: NonNullable<ReturnType<typeof actionLine>> }) => {
  const { glob } = ctx;
  const { arming } = line;
  return (
    <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5" data-testid="action-line-info">
      {arming !== null && (
        <>
          <ArmSystemLabel label={arming} onOpen={() => findSection(document, 'human-steps')?.scrollIntoView({ block: 'start' })} />
          <Dot />
        </>
      )}
      <span className={`${META} min-w-0 truncate text-muted-foreground`} data-testid="glob-branch" title="The glob's branch">
        {glob.branch}
      </span>
    </div>
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
  const says = takeOverConfirmation(ctx.glob, state.viewer?.email);
  return (
    <div
      role="alertdialog"
      aria-label={says.title}
      data-testid="take-over-confirmation"
      className="grid gap-2 rounded border border-amber/60 bg-amber/10 p-3 text-xs"
    >
      <strong>{says.title}</strong>
      <p data-testid="take-over-happens">{says.happens}</p>
      {state.brief !== null && (
        <p data-testid="handover-confirmation">{handoverConfirmation('take_over', state.brief)}</p>
      )}
      <code className="rounded bg-muted px-2 py-1" data-testid="take-over-command">
        {says.command}
      </code>
      <p data-testid="take-over-how">{says.how}</p>
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
          Confirm pick up
        </Button>
      </div>
    </div>
  );
};

/** A split move: not a machine action, so it has no presentation entry; it opens the split form. */
interface SplitMove {
  id: 'split';
  label: string;
  tip: string;
  run: () => void;
}

const SPLIT_TIP =
  'Cut the scope into independent globs: part 1 stays here, the others are created with their share of the plan';

/** The split move for the glob: Split… in the menu of a splittable glob (a scope cut; the oversized flag only advises). */
const splitMoves = (
  ctx: GlobViewContext,
  state: GlobActionsState,
  onSplitting: (splitting: boolean) => void,
): { lead: SplitMove | null; menu: SplitMove[] } => {
  const { glob } = ctx;
  if (state.human) return { lead: null, menu: [] };
  const move: SplitMove = { id: 'split', label: 'Split…', tip: SPLIT_TIP, run: () => onSplitting(true) };
  return { lead: null, menu: splittable(glob, state.decision) ? [move] : [] };
};

/** An action's Done (an optional note) and Dismiss (a reason) asked for before the action ends. */
const FinishAction = ({ ctx, state }: { ctx: GlobViewContext; state: GlobActionsState }) => {
  const [text, setText] = useState('');
  const kind = state.finishing;
  useEffect(() => setText(''), [kind, ctx.glob.id]);
  if (kind === null) return null;
  const dismissing = kind === 'dismiss_action';
  return (
    <div
      role="alertdialog"
      aria-label={dismissing ? 'Dismiss this action' : 'Mark this action done'}
      className="grid gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
      data-testid={dismissing ? 'dismiss-action-confirmation' : 'done-action-confirmation'}
    >
      <label className="grid gap-1">
        <span>
          {dismissing
            ? 'Why is it not needed? Whatever waits for it is released, so say why.'
            : 'What did you check? (optional) You are saying the work is done.'}
        </span>
        <Input
          value={text}
          autoFocus
          maxLength={2000}
          data-testid="action-note"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => state.setFinishing(null)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={state.busy || (dismissing && text.trim() === '')}
          data-testid="confirm-finish-action"
          onClick={() => void state.finish(kind, text)}
        >
          {dismissing ? 'Dismiss' : 'Done'}
        </Button>
      </div>
    </div>
  );
};

/** The `actions` section's content: the handover box, the main button, More ▾ and the confirmations. */
export const GlobActions = ({
  ctx,
  state,
  onSplitting,
}: {
  ctx: GlobViewContext;
  state: GlobActionsState;
  onSplitting: (splitting: boolean) => void;
}) => {
  const { glob } = ctx;
  const { pending, actions, tiers, disabled, brief } = state;
  const busy = state.busy;
  const moves = splitMoves(ctx, state, onSplitting);
  // While a block needs the person (a decision to make, a blocking question, a due step, a review to approve) its buttons are the
  // only way forward: the row has no main button and no ▾. In Planning the blocks have no buttons and the main action stays.
  const flow = ctx.decide ?? null;
  const blocking = blockingItem(
    glob,
    ctx.board.role,
    state.viewer,
    flow === null || flow.learning === null || flow.learning.status === 'open',
  );
  const lead = blocking === null ? moves.lead : null;
  // The decision's outcomes live in its block, so Decide is never the row's button.
  const inBlock = ctx.decide != null && state.main === 'decide';
  const main = blocking === null && lead === null && !inBlock ? state.main : null;
  // Only the glob-wide escape stays while a block holds the glob: the quiet ⋯.
  const escapes = blocking === null ? [] : actions.filter((a) => a === 'take_over');
  const moreActions = actions.filter(
    (a) => a !== main && !(inBlock && a === 'decide') && tiers.get(a) !== 'destructive',
  );
  // The menu closes on select, so the More button shows the action it started while it runs.
  const moreRunning =
    busy && pending !== null && moreActions.includes(pending.action) ? pending.action : null;
  const { confirmingOversized } = state;
  // The ▾ only ever joins a main button: with none (no allowed action to promote) the row shows nothing.
  const hasMain = main !== null || lead !== null;
  const hasMenu = hasMain && moves.menu.length + moreActions.length + disabled.length > 0;
  const menuItems = (
    <>
      {moves.menu.map((move) => (
        <DropdownMenuItem
          key={move.id}
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
    </>
  );
  const menu = hasMenu ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant={state.variant}
          className={
            state.variant === 'outline'
              ? 'rounded-l-none -ml-px px-1.5'
              : 'rounded-l-none border-l-primary-foreground/40 px-1.5'
          }
          disabled={busy}
          aria-label="More actions"
          data-testid="more-actions"
        >
          {moreRunning === null ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <Loader2
              className="size-3.5 animate-spin"
              aria-label={workingLabel(moreRunning)}
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="more-menu">
        {menuItems}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : undefined;
  const line = actionLine(ctx);
  const info = line === null ? null : <ActionLineInfo ctx={ctx} line={line} />;
  return (
    <>
      {(hasMain || escapes.length > 0 || info !== null) && (
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2" data-testid="glob-actions">
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
                    <HumanIcon decorative />
                    {lead.label}
                  </Button>
                </Tip>
                {menu}
              </div>
            )}
            {escapes.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label="More"
                    data-testid="more-escape"
                  >
                    <Ellipsis className="size-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" data-testid="more-escape-menu">
                  {escapes.map((action) => {
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
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {main !== null && (
              <div className="inline-flex" data-testid="split-button">
                <Tip text={tipOf(main, glob, state.viewer?.email)}>
                  <Button
                    size="sm"
                    variant={state.variant}
                    className={hasMenu ? 'rounded-r-none' : undefined}
                    disabled={busy}
                    data-testid="main-action"
                    data-variant={state.variant}
                    onClick={() => state.begin(main)}
                  >
                    <ActionContent action={main} ctx={ctx} state={state} />
                  </Button>
                </Tip>
                {menu}
              </div>
            )}
            {info}
          </div>
          <FinishAction ctx={ctx} state={state} />
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
          {confirmingOversized !== null && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
            >
              <span className="flex-1" data-testid="oversized-start-says">
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
                Continue
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
  // A learning can be deleted too, but only Reject suppresses its repeats, so its confirmation says so.
  const attributes = decisionOf(glob);
  const learning = attributes !== null && isLearning(attributes);
  // Delete follows the server's permission: offered whenever the viewer may delete this glob.
  const mayDelete = (glob.allowedActions ?? []).includes('delete');
  const showDelete = mayDelete && !state.confirmDelete;
  const hasContent =
    resetActions.length > 0 || state.confirmDelete || state.confirmingAgain || showDelete;
  // Never an empty red box: the area exists only while it has something to show.
  if (!hasContent) return null;
  return (
    <div className="grid gap-2 rounded border border-destructive/50 p-3" data-testid="reset-area">
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
        {showDelete && (
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
          {learning ? (
            <p data-testid="delete-learning-warning">
              <strong>Delete {glob.id} permanently?</strong> Deleting forgets this learning. If slop
              spots the same thing again, it comes back as new. To say no and stop repeats, use{' '}
              <a
                href="#section-actions"
                className="underline"
                onClick={() => state.setConfirmDelete(false)}
              >
                Reject
              </a>{' '}
              instead.
            </p>
          ) : (
            <p>
              <strong>Delete {glob.id} permanently?</strong> This removes the glob, its branch, its
              PR, its artifacts and its events, so its time leaves the reports. There is no archive.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => state.setConfirmDelete(false)}>
              {learning ? 'Cancel' : 'Keep it'}
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
