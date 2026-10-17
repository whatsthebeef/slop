import { actionPresentation, armLabel, blockedParts, chainTip, decisionOf, isHumanCategory, machine, mainVariant, mergeWarning, viewActions, waitingFor } from '@slop/core';
import type { Action, EditFailure, PendingAction } from '@slop/core';
import { isLearning } from '../decision-outcomes';
import { useEffect, useState } from 'react';
import { ChevronDown, Ellipsis } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { actionTiers, orderActions } from '@/lib/action-style';
import { clickOf, presentOf } from '@/lib/present';
import { takeOverConfirmation } from '@/lib/sstor-command';
import { ActorIcon, HumanIcon } from '@/components/actor-icons';
import { findSection } from '@/lib/glob-scroll';
import { startAgainConfirmation } from '@/lib/start-again';
import { handoverConfirmation, handoverToShow } from '@/lib/handover';
import { anywayConfirmation, anywayOf, reasonRequired } from '@/lib/anyway';
import type { AnywayAction } from '@/lib/anyway';
import { typeOptions } from '@/lib/type-change';
import type { TypeOption } from '@/lib/type-change';
import { Tip } from '../ui/tip';
import { ArmSystemLabel } from '../glob-card';
import { META } from './tag-style';
import { Notice } from './notice';
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
  onCompleteStep,
  email,
  learningOpen,
  running,
  setRunning: setBusy,
}: Pick<GlobViewContext, 'board' | 'glob' | 'onAction' | 'onUpdate'> & {
  /** An action or save is running (owned by the page: the decide flow reads it too). */
  running: boolean;
  setRunning: (running: boolean) => void;
  /** Ticks a work step (the main button of a due rollout step); resolves false when it failed. */
  onCompleteStep?: (stepId: string) => Promise<boolean>;
  /** Who is looking, for the steps that are theirs (unknown until /api/me has answered). */
  email?: string;
  /** False for a learning whose outcome is already in (its decision block has nothing left to decide). */
  learningOpen?: boolean;
}) => {
  // A decision glob has no branch, PR, runs, deploys or labels: those parts of the view are left out. Nor has an action.
  const decision = decisionOf(glob) !== null;
  const human = isHumanCategory(glob.category);
  // The click this page has sent, until the glob shows it itself (the page reloads the glob when the request returns): same shape as the stored one.
  const [sent, setSent] = useState<PendingAction | null>(null);
  const viewer = email === undefined ? undefined : { email, role: board.role };
  // Everything the page says about the glob (status, primary action, notice, activity) comes from this one presentation.
  const presentation = presentOf(glob, {
    ...(viewer === undefined ? {} : { viewer }),
    base: board.baseBranch,
    repo: board.repo,
    pending: sent,
    ...(learningOpen === undefined ? {} : { learningOpen }),
  });
  const busy = running;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  /** Sends an action: the glob shows it in progress at once, and a second click does nothing while one is out. */
  const act = async (action: Action, anyway?: boolean, text?: string): Promise<boolean> => {
    if (running || presentation.pending !== null) return false;
    setSent(clickOf(action, email ?? ''));
    setBusy(true);
    try {
      // Only what was asked for goes along: a plain click is a plain `onAction(action)`.
      return await (text !== undefined ? onAction(action, anyway, text) : anyway !== undefined ? onAction(action, anyway) : onAction(action));
    } finally {
      setBusy(false);
      setSent(null);
    }
  };

  const [stepsSignal, setStepsSignal] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmingRetrigger, setConfirmingRetrigger] = useState(false);
  // The type chip's popover says what follows before it changes the type.
  const [typeFailure, setTypeFailure] = useState<EditFailure | null>(null);
  const typeChoices = typeOptions(glob, board.role);
  const changeType = async (option: TypeOption) => {
    setTypeFailure(null);
    if (option.via === 'update') {
      setTypeFailure(await onUpdate({ type: option.to }));
    } else if (option.via !== null && !(await act(option.via))) {
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
  const [finishing, setFinishing] = useState<'complete_action' | 'dismiss_action' | 'fail_action' | null>(null);
  // Start now, Merge anyway and Sign off anyway override what holds the glob back: they say what it is and ask why first.
  const [confirmingAnyway, setConfirmingAnyway] = useState<AnywayAction | null>(null);
  // "Why you're needed": what the confirmations of Pick up and Start say.
  const brief = handoverToShow(glob);
  useEffect(() => {
    setConfirmingAgain(false);
    setConfirmingTakeOver(false);
    setTypeFailure(null);
    setConfirmingOversized(null);
    setFinishing(null);
    setConfirmingAnyway(null);
  }, [glob.id]);

  // deescalate and make_super are reached through the type popover.
  const shownActions = viewActions(glob, email);
  // Decide has its own panel with the five outcomes: it can be the main button (which goes to
  // the panel), never a More entry.
  const allActions = shownActions.filter((a) => a !== 'decide');
  // A stalled glob's step names the one action to lead with and one alternative to follow it.
  const stall = glob.humanSteps?.find((s) => s.kind === 'unstick');
  // The one primary action (none while a click is pending or a block holds the glob): the presentation decides, never this row.
  const main = presentation.primary;
  // A stalled glob's step (nobody moving it) makes Pick up the black main; while a sub's machine progresses it stays quiet.
  const variant = mainVariant(main, glob, stall !== undefined);
  const actions = orderActions(allActions, main, stall?.alternative);
  const tiers = actionTiers(allActions, main);
  const disabled = waitingFor(glob, actions, board.role);
  const reviewedAtHead = (glob.artifacts ?? []).some(
    (a) => a.kind === 'local_review' && machine.sameCommit(a.commitSha, glob.pr?.headSha),
  );
  const markReady = () =>
    run(async () => {
      setConfirmingReady(false);
      await act('mark_ready');
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
    if (action === 'complete_action' || action === 'dismiss_action' || action === 'fail_action') {
      setFinishing(action);
      return;
    }
    const overriding = anywayOf(action, glob);
    if (overriding !== null) {
      setConfirmingAnyway(overriding);
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
    void act(action);
  };

  /** Ends the action glob: Done with the note, or Dismiss with the reason. */
  const finish = (action: 'complete_action' | 'dismiss_action' | 'fail_action', text: string) =>
    run(async () => {
      if (await onAction(action, undefined, text)) setFinishing(null);
    });

  /** Runs the overriding action with the reason typed in its confirmation: one request, whatever the clicks. */
  const confirmAnyway = (action: AnywayAction, reason: string) =>
    act(action, undefined, reason).then((ok) => {
      if (ok) setConfirmingAnyway(null);
    });

  return {
    decision,
    human,
    presentation,
    act,
    confirmingAnyway,
    setConfirmingAnyway,
    confirmAnyway,
    finishing,
    setFinishing,
    finish,
    busy,
    run,
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

const ActionContent = ({ action, ctx, state }: { action: Action; ctx: GlobViewContext; state: GlobActionsState }) => {
  const shown = actionPresentation(action, ctx.glob, false, state.viewer?.email);
  return (
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
 * Beside the action row (under it on narrow widths): the Arm system label (no step title), or the branch when there is no
 * such step, one quiet mono line.
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
        <ArmSystemLabel label={{ ...arming, tip: 'A person has a step at release. Opens Human steps' }} onOpen={() => findSection(document, 'human-steps')?.scrollIntoView({ block: 'start' })} />
      )}
      {arming === null && (
        <span className={`${META} min-w-0 truncate text-muted-foreground`} data-testid="glob-branch" title="The glob's branch">
          {glob.branch}
        </span>
      )}
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
          onClick={() => {
            state.setConfirmingTakeOver(false);
            void state.act('take_over');
          }}
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
  const failing = kind === 'fail_action';
  return (
    <div
      role="alertdialog"
      aria-label={dismissing ? 'Dismiss this action' : failing ? 'Report that the run failed' : 'Mark this action done'}
      className="grid gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
      data-testid={dismissing ? 'dismiss-action-confirmation' : failing ? 'fail-action-confirmation' : 'done-action-confirmation'}
    >
      <label className="grid gap-1">
        <span>
          {dismissing
            ? 'Why is it not needed? Whatever waits for it is released, so say why.'
            : failing
              ? 'Paste the output of the run (secrets are masked). The machine prepares another round on the same branch.'
              : 'What did you check? (optional) You are saying the work is done.'}
        </span>
        {failing ? (
          <textarea
            value={text}
            autoFocus
            rows={6}
            maxLength={20000}
            className="w-full rounded border bg-background p-2 font-mono text-xs"
            data-testid="action-failure-output"
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <Input
            value={text}
            autoFocus
            maxLength={2000}
            data-testid="action-note"
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </label>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => state.setFinishing(null)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={state.busy || ((dismissing || failing) && text.trim() === '')}
          data-testid="confirm-finish-action"
          onClick={() => void state.finish(kind, text)}
        >
          {dismissing ? 'Dismiss' : failing ? 'Failed' : 'Done'}
        </Button>
      </div>
    </div>
  );
};

/** Start now, Merge anyway and Sign off anyway: what the glob is held for, and why it goes ahead (required for the last two). */
const AnywayConfirmation = ({ ctx, state }: { ctx: GlobViewContext; state: GlobActionsState }) => {
  const [text, setText] = useState('');
  const action = state.confirmingAnyway;
  useEffect(() => setText(''), [action, ctx.glob.id]);
  if (action === null) return null;
  const says = anywayConfirmation(action, ctx.glob);
  const needed = reasonRequired(action);
  const brief = action === 'start_anyway' ? state.brief : null;
  return (
    <div
      role="alertdialog"
      aria-label={says.title}
      className="grid gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
      data-testid="anyway-confirmation"
      data-action={action}
    >
      <p data-testid="anyway-says">{says.says}</p>
      {brief !== null && <p data-testid="handover-confirmation">{handoverConfirmation('start_anyway', brief)}</p>}
      <label className="grid gap-1">
        <span>{says.ask}</span>
        <Input value={text} autoFocus maxLength={2000} data-testid="anyway-reason" onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => state.setConfirmingAnyway(null)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={state.busy || (needed && text.trim() === '')}
          data-testid="confirm-anyway"
          onClick={() => void state.confirmAnyway(action, text.trim())}
        >
          {says.title}
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
  const { actions, tiers, disabled, brief } = state;
  const busy = state.busy;
  const moves = splitMoves(ctx, state, onSplitting);
  // While a block needs the person (a decision to make, a blocking question, a due step, a review to approve) its buttons are the
  // only way forward: the row has no main button and no ▾ (the presentation's `primary` is then none). In Planning the blocks have
  // no buttons and the main action stays. A click in progress hides the button too: the header's status says so, never this row.
  const blocking = state.presentation.blocking;
  const lead = blocking === null ? moves.lead : null;
  const main = lead === null ? state.main : null;
  // Only the glob-wide escape stays while a block holds the glob: the quiet ⋯.
  const escapes = blocking === null ? [] : actions.filter((a) => a === 'take_over');
  // A block that leaves an override as the primary (Merge anyway) keeps the rest of the row as quiet as any other block.
  const menuCandidates =
    blocking === null ? actions.filter((a) => a !== main && a !== 'decide' && tiers.get(a) !== 'destructive') : [];
  // With no primary the row still shows a button: the first glob-wide action as an outline, never a bare ▾ (Cancel merge while merging).
  const promoted =
    main === null && lead === null && blocking === null && state.presentation.pending === null && !busy
      ? (['cancel_merge', 'review_now', 'take_over', 'pick_up'] as const).find((a) => menuCandidates.includes(a)) ?? menuCandidates[0] ?? null
      : null;
  const moreActions = menuCandidates.filter((a) => a !== promoted);
  const { confirmingOversized } = state;
  // The ▾ only ever joins a main button: with none (no allowed action to promote) the row shows nothing.
  const hasMain = main !== null || lead !== null || promoted !== null;
  const hasMenu = hasMain && blocking === null && moves.menu.length + moreActions.length + disabled.length > 0;
  // Destructive actions never lead and have their own visible danger buttons below, so a menu of only them never shows.
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
          variant={promoted !== null ? 'outline' : state.variant}
          className={
            promoted !== null
              ? 'rounded-l-none -ml-px px-1.5'
              : state.variant === 'outline'
                ? 'rounded-l-none -ml-px px-1.5'
                : 'rounded-l-none border-l-primary-foreground/40 px-1.5'
          }
          disabled={busy}
          aria-label="More actions"
          data-testid="more-actions"
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="more-menu">
        {menuItems}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : undefined;
  const line = actionLine(ctx);
  const info = line === null ? null : <ActionLineInfo ctx={ctx} line={line} />;
  const notice = state.presentation.notice;
  return (
    <>
      {(hasMain || escapes.length > 0 || info !== null || notice !== null) && (
        <div className="grid gap-1">
          <Notice ctx={ctx} notice={notice} />
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
            {promoted !== null && (
              <div className="inline-flex" data-testid="split-button">
                <Tip text={tipOf(promoted, glob, state.viewer?.email)}>
                  <Button
                    size="sm"
                    variant="outline"
                    className={hasMenu ? 'rounded-r-none' : undefined}
                    disabled={busy}
                    data-testid="main-action"
                    data-variant="outline"
                    onClick={() => state.begin(promoted)}
                  >
                    <ActionContent action={promoted} ctx={ctx} state={state} />
                  </Button>
                </Tip>
                {menu}
              </div>
            )}
            {info}
          </div>
          <FinishAction ctx={ctx} state={state} />
          <AnywayConfirmation ctx={ctx} state={state} />
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
                onClick={() => {
                  const action = confirmingOversized;
                  state.setConfirmingOversized(null);
                  void state.act(action);
                }}
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
                onClick={() => {
                  state.setConfirmingRetrigger(false);
                  void state.act('retrigger', true);
                }}
              >
                Retry anyway
              </Button>
            </div>
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
  const { glob } = ctx;
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
            {startAgainConfirmation(glob)}
          </span>
          <Button size="sm" variant="ghost" onClick={() => state.setConfirmingAgain(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            data-testid="confirm-start-again"
            onClick={() => {
              state.setConfirmingAgain(false);
              void state.act('start_again');
            }}
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
