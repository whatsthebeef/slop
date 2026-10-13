import { decisionOf, machine } from '@slop/core';
import type { Action, EditFailure } from '@slop/core';
import { useEffect, useState } from 'react';
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
import { mainAction } from '@/lib/main-action';
import { ActorIcon } from '@/components/actor-icons';
import { findSection } from '@/lib/glob-scroll';
import { workingLabel } from '@/lib/card-pending';
import { PENDING_TIMEOUT_MS, isPending, startAction } from '@/lib/pending-action';
import type { PendingAction } from '@/lib/pending-action';
import { startAgainConfirmation } from '@/lib/start-again';
import {
  handoverConfirmation,
  handoverOneLine,
  handoverToShow,
  readHandoverAcknowledged,
  writeHandoverAcknowledged,
} from '@/lib/handover';
import { chainTip, mergeWarning, waitingFor } from '@/lib/status-line';
import { typeOptions } from '@/lib/type-change';
import type { TypeOption } from '@/lib/type-change';
import { isOversized } from '../oversized-glob';
import { Tip } from '../ui/tip';
import { TypePopover } from '../type-popover';
import type { GlobViewContext } from './context';

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
}: Pick<GlobViewContext, 'board' | 'glob' | 'onAction' | 'onUpdate'>) => {
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
  // A super's local review normally comes first (/finalise); the board warns, then allows.
  const [confirmingReady, setConfirmingReady] = useState(false);
  // Done changes nothing until GitHub confirms, so say it was asked for meanwhile.
  const [readyAsked, setReadyAsked] = useState(false);
  // "Why you're needed": the full box until the viewer acknowledges it, then one line.
  const brief = handoverToShow(glob);
  const [briefRead, setBriefRead] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  useEffect(() => {
    setConfirmingAgain(false);
    setTypeFailure(null);
    setConfirmingOversized(null);
    setBriefOpen(false);
  }, [glob.id]);
  useEffect(
    () => setBriefRead(brief !== null && readHandoverAcknowledged(glob.id, brief)),
    [glob.id, brief === null ? '' : JSON.stringify(brief)],
  );

  // deescalate and make_super are reached through the type popover.
  const shownActions = presentedActions(glob.allowedActions ?? []).filter(
    (a) => a !== 'delete' && actionPresentation(a, glob).placement !== 'none',
  );
  // Decide has its own panel with the five outcomes: it can be the main button (which goes to
  // the panel), never a More entry.
  const allActions = shownActions.filter((a) => a !== 'decide');
  // A stalled glob's step names the one action to lead with and one alternative to follow it.
  const stall = glob.humanSteps?.find((s) => s.kind === 'unstick');
  const leading = stall?.action === undefined || stall.action === 'open_session' ? undefined : stall.action;
  const main = mainAction(shownActions, glob, decision, leading);
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
    if (action === 'retrigger' && (glob.blockedBy?.length ?? 0) > 0) {
      setConfirmingRetrigger(true);
      return;
    }
    if (
      (oversized &&
        (action === 'start' ||
          action === 'start_anyway' ||
          action === 'pick_up' ||
          action === 'take_over')) ||
      (brief !== null &&
        (action === 'start_anyway' || action === 'pick_up' || action === 'take_over'))
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
    actions,
    tiers,
    disabled,
    typeChoices,
    typeFailure,
    changeType,
    oversized,
    brief,
    briefRead,
    setBriefRead,
    briefOpen,
    setBriefOpen,
    confirmDelete,
    setConfirmDelete,
    confirmingAgain,
    setConfirmingAgain,
    confirmingRetrigger,
    setConfirmingRetrigger,
    confirmingOversized,
    setConfirmingOversized,
    confirmingReady,
    setConfirmingReady,
    readyPending,
    markReady,
  };
};

export type GlobActionsState = ReturnType<typeof useGlobActions>;

/** Merge also warns when the base moved since the checks ran (slop merges it first). */
const tipOf = (action: Action, glob: GlobViewContext['glob']) => {
  const tip = actionPresentation(action, glob).tip;
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
  const shown = actionPresentation(action, ctx.glob);
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

/** Why the viewer is needed: the full box until acknowledged, then one line. */
const HandoverBox = ({ ctx, state }: { ctx: GlobViewContext; state: GlobActionsState }) => {
  const { brief, briefRead, briefOpen } = state;
  if (brief === null) return null;
  return (
    <div
      className="mb-2 grid gap-1 rounded border border-amber/60 bg-amber/10 p-2 text-sm"
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
            {brief.why.map((cause) => (
              <li key={cause}>{cause}</li>
            ))}
          </ul>
          <p>
            <strong>First:</strong> {brief.next}
          </p>
          {brief.detail.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {brief.detail.map((line) => (
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
                writeHandoverAcknowledged(ctx.glob.id, brief);
                state.setBriefRead(true);
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

/** The `actions` section's content: the handover box, the main button, More ▾ and the confirmations. */
export const GlobActions = ({ ctx, state }: { ctx: GlobViewContext; state: GlobActionsState }) => {
  const { glob } = ctx;
  const { busy, pending, main, actions, tiers, disabled, brief, oversized } = state;
  const moreActions = actions.filter((a) => a !== main && tiers.get(a) !== 'destructive');
  // The menu closes on select, so the More button shows the action it started while it runs.
  const moreRunning =
    busy && pending !== null && moreActions.includes(pending.action) ? pending.action : null;
  const { confirmingOversized } = state;
  return (
    <>
      <HandoverBox ctx={ctx} state={state} />
      {(main !== null || actions.length + disabled.length > 0) && (
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2" data-testid="glob-actions">
            {main !== null && (
              <Tip text={tipOf(main, glob)}>
                <Button
                  size="sm"
                  disabled={busy}
                  data-testid="main-action"
                  onClick={() => state.begin(main)}
                >
                  <ActionContent action={main} ctx={ctx} state={state} />
                </Button>
              </Tip>
            )}
            {moreActions.length + disabled.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={busy} data-testid="more-actions">
                    {moreRunning === null ? (
                      <>
                        More
                        <ChevronDown className="size-3.5" aria-hidden />
                      </>
                    ) : (
                      <>
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        {workingLabel(moreRunning)}
                      </>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent data-testid="more-menu">
                  {moreActions.map((action) => {
                    const shown = actionPresentation(action, glob);
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
                          {tipOf(action, glob)}
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
