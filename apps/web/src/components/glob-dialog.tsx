import { decisionOf, machine } from '@slop/core';
import type { Action, EditFailure, LabelName, SuggestionPrefill } from '@slop/core';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, ChevronDown, Loader2 } from 'lucide-react';
import { Link } from 'react-router';
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
import type { BoardView, DecideInput, GlobChanges, GlobView } from '@/lib/api';
import { findSection, scrollWhenReady } from '@/lib/glob-scroll';
import type { GlobSection } from '@/lib/glob-section';
import { workingLabel } from '@/lib/card-pending';
import { PENDING_TIMEOUT_MS, isPending, startAction } from '@/lib/pending-action';
import type { PendingAction } from '@/lib/pending-action';
import { OPEN_OVERLAY, escapeGoesBack } from '@/lib/glob-back';
import { startAgainConfirmation } from '@/lib/start-again';
import {
  handoverConfirmation,
  handoverOneLine,
  handoverToShow,
  readHandoverAcknowledged,
  writeHandoverAcknowledged,
} from '@/lib/handover';
import {
  chainTip,
  viewStatusLine,
  waitingFor,
  mergeWarning,
} from '@/lib/status-line';
import { typeOptions } from '@/lib/type-change';
import type { TypeOption } from '@/lib/type-change';
import { ConflictSection } from './glob-view/conflict';
import { DependenciesSection } from './glob-view/dependencies';
import { EditFieldsSection, useGlobEdits } from './glob-view/edit-fields';
import { EscalationSection } from './glob-view/escalation';
import { SizeSection } from './glob-view/size';
import type { ArtifactRef } from './artifacts';
import { GroupChip } from './glob-card';
import { moveOf, positionOf, stepLabel, stepsOf, stepWords } from '@/lib/position';
import { LabelChips, LabelReviews } from './labels';
import type { ReviewLabel } from './labels';
import { isOversized } from './oversized-glob';
import { GlobTitle } from './glob-title';
import { ArtifactsPanel } from './glob-view/artifacts';
import { ChoicesPanel } from './glob-view/choices';
import type { GlobViewContext } from './glob-view/context';
import { DecisionAssessmentPanel, DecisionPanel } from './glob-view/decision';
import { DeploysPanel } from './glob-view/deploys';
import { EnvironmentsPanel } from './glob-view/environments';
import { FindingsPanel } from './glob-view/findings';
import { PlanSection } from './glob-view/plan';
import { TestsPanel } from './glob-view/tests';
import { cn } from '@/lib/utils';
import { Tip } from './ui/tip';
import { TypePopover } from './type-popover';

const STATUS_TEXT: Record<GlobView['status'], string> = {
  planning: 'Planning',
  implementing: 'A routine is implementing',
  in_progress: 'In progress',
  failed: 'Failed',
  pr_open: 'PR open for review',
  merging: 'Merging',
  reviewing: 'Merged; awaiting sign-off',
  signed_off: 'Signed off',
};

/** A decision glob uses the same lists for a different journey: it is decided in Doing and signed off once accepted. */
const DECISION_STATUS_TEXT: Partial<Record<GlobView['status'], string>> = {
  in_progress: 'Doing: being decided',
  reviewing: 'Decided; awaiting sign-off',
};

const when = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString());

/** A section's anchor: found by `?section=`, and left below the sticky header (h-10) when scrolled to. Hidden while empty. */
const Anchor = ({ name, children }: { name: GlobSection; children: ReactNode }) => (
  <div id={`section-${name}`} data-section={name} className="scroll-mt-12 empty:hidden">
    {children}
  </div>
);

/** The "Now" row at the top of the actions area: who has the ball, why and for how long, and the machine steps behind it. */
const NowRow = ({ glob }: { glob: GlobView }) => {
  const now = new Date().toISOString();
  const position = positionOf(glob, now);
  const move = moveOf(glob, now);
  const steps = stepsOf(glob).filter((s) => s.state !== 'done');
  if (position === null && steps.length === 0 && move.holder !== 'you') return null;
  const holder =
    move.holder === 'you'
      ? 'Your turn'
      : position === null
        ? ''
        : { human: 'Their turn', machine: 'Machine', waiting: 'Waiting', stalled: 'Stalled' }[position.holder];
  const minutes = position?.minutes ?? null;
  return (
    <div className="text-sm" data-testid="now-row" data-holder={move.holder}>
      <p className={cn('font-medium', position?.tone)}>
        <span className="text-muted-foreground">Now: </span>
        {holder}
        {move.reason !== '' && ` · ${move.reason}`}
        {minutes !== null && minutes > 0 && (
          <span className="font-normal text-muted-foreground"> · {minutes} min</span>
        )}
      </p>
      {steps.length > 0 && (
        <details data-testid="machine-steps">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Machine steps ({steps.length})
          </summary>
          <ul className="mt-1 space-y-0.5 text-xs">
            {steps.map((step) => (
              <li key={step.id} data-kind={step.kind} data-state={step.state}>
                {stepLabel(step)} <span className="text-muted-foreground">{stepWords(step, now)}</span>
                {step.detail !== null && /^https?:\/\//.test(step.detail) && (
                  <>
                    {' '}
                    <a className="underline" href={step.detail} target="_blank" rel="noreferrer">
                      open
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

/** The glob view: a page in the board's main area (never a modal), with a back arrow to the board. */
export const GlobDetail = ({
  board,
  glob,
  initialArtifact,
  section = null,
  openLabel = null,
  onClose,
  onUpdate,
  onReload,
  onAction,
  onReviewLabel,
  onDecide,
  onDelete,
}: {
  board: BoardView;
  glob: GlobView;
  /** The artifact to show first (from a card icon). */
  initialArtifact: ArtifactRef | null;
  /** The section to scroll to once it has rendered (from `?section=`); unknown or null stays at the top. */
  section?: GlobSection | null;
  /** The sign-off label whose review to bring into view (from `?section=labels&label=`). */
  openLabel?: LabelName | null;
  onClose: () => void;
  /** Saves the edits; resolves null when saved, or why the server refused them. */
  onUpdate: (changes: GlobChanges) => Promise<EditFailure | null>;
  /** Loads the glob's latest values into the view (after a version conflict). */
  onReload: () => Promise<void>;
  /** Resolves false when the action failed. */
  /** `anyway` goes ahead of unmerged prerequisites (Retry). */
  onAction: (action: Action, anyway?: boolean) => Promise<boolean>;
  onReviewLabel: ReviewLabel;
  /** Decision globs: the outcome chosen in Doing; resolves false when it failed. */
  onDecide: (input: DecideInput) => Promise<boolean>;
  onDelete: () => Promise<void>;
}) => {
  // A decision glob has no branch, PR, runs, deploys or labels: those parts of the view are left out.
  const decision = decisionOf(glob) !== null;
  const edits = useGlobEdits(glob.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  const [artifact, setArtifact] = useState<ArtifactRef | null>(initialArtifact);
  // Suggest's Apply: the decision form opens pre-filled; reset when another glob opens.
  const [applied, setApplied] = useState<SuggestionPrefill | null>(null);
  useEffect(() => setApplied(null), [glob.id]);
  useEffect(() => {
    setConfirmingAgain(false);
    setTypeFailure(null);
  }, [glob.id]);
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
  useEffect(() => setArtifact(initialArtifact), [glob.id, initialArtifact]);
  // Once per navigation (glob or section), not on the live refreshes that re-render the page.
  useEffect(() => {
    if (section === null) return undefined;
    return scrollWhenReady(() => findSection(document, section));
  }, [glob.id, section]);

  const [splitting, setSplitting] = useState(false);
  useEffect(() => setSplitting(false), [glob.id]);
  const oversized = isOversized(glob);
  // Starting a flagged glob asks first: it is likely more than one PR's worth of work.
  const [confirmingOversized, setConfirmingOversized] = useState<Action | null>(null);
  useEffect(() => setConfirmingOversized(null), [glob.id]);
  // deescalate and make_super are reached through the type popover.
  const shownActions = presentedActions(glob.allowedActions ?? []).filter(
    (a) => a !== 'delete' && actionPresentation(a, glob).placement !== 'none',
  );
  // Decide has its own panel with the five outcomes: it can be the main button (which goes to
  // the panel), never a More entry.
  const allActions = shownActions.filter((a) => a !== 'decide');
  const main = mainAction(shownActions, glob, decision);
  const actions = orderActions(allActions, main);
  const tiers = actionTiers(allActions, main);
  const disabled = waitingFor(glob, actions, board.role);
  const status = viewStatusLine(glob, new Date().toISOString(), disabled);
  // Done changes nothing until GitHub confirms, so say it was asked for meanwhile.
  const [readyAsked, setReadyAsked] = useState(false);
  const readyPending = readyAsked && glob.status === 'in_progress' && glob.pr?.state === 'draft';
  // A super's local review normally comes first (/finalise); the board warns, then allows.
  const [confirmingReady, setConfirmingReady] = useState(false);
  // "Why you're needed": the full box until the viewer acknowledges it, then one line.
  const brief = handoverToShow(glob);
  const [briefRead, setBriefRead] = useState(false);
  useEffect(
    () => setBriefRead(brief !== null && readHandoverAcknowledged(glob.id, brief)),
    [glob.id, brief === null ? '' : JSON.stringify(brief)],
  );
  const [briefOpen, setBriefOpen] = useState(false);
  useEffect(() => setBriefOpen(false), [glob.id]);
  // Discard throws the PR and branch away, so it says what it will do first.
  const [confirmingAgain, setConfirmingAgain] = useState(false);
  // The header's border shows once the page has scrolled under it.
  const topRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = topRef.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) =>
      setScrolled(entry !== undefined && !entry.isIntersecting),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Esc goes back to the board, unless typing, an overlay or an inline confirmation owns it.
  const confirming = confirmDelete || confirmingAgain || splitting;
  const escapeRef = useRef({ onClose, confirming });
  escapeRef.current = { onClose, confirming };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const target = { tag: t?.tagName ?? 'BODY', editable: t?.isContentEditable ?? false };
      if (
        !escapeGoesBack(
          e.key,
          e.defaultPrevented,
          target,
          document.querySelector(OPEN_OVERLAY) !== null,
          escapeRef.current.confirming,
        )
      )
        return;
      escapeRef.current.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const reviewedAtHead = (glob.artifacts ?? []).some(
    (a) => a.kind === 'local_review' && machine.sameCommit(a.commitSha, glob.pr?.headSha),
  );
  const markReady = () =>
    run(async () => {
      setConfirmingReady(false);
      if (await onAction('mark_ready')) setReadyAsked(true);
    });

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  const ctx: GlobViewContext = {
    board,
    glob,
    busy,
    onAction,
    onUpdate,
    onOpenSection: (target) => {
      const { section: wanted } = target;
      if (wanted !== undefined) scrollWhenReady(() => findSection(document, wanted));
    },
  };

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

  // Merge also warns when the base moved since the checks ran (slop merges it first).
  const tipOf = (action: Action) => {
    const tip = actionPresentation(action, glob).tip;
    const warning = action === 'merge' ? mergeWarning(glob) : null;
    return warning === null ? tip : `${tip}\n${warning}`;
  };

  const actionContent = (action: Action) => {
    const shown = actionPresentation(action, glob);
    return busy && pending?.action === action ? (
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

  const moreActions = actions.filter((a) => a !== main && tiers.get(a) !== 'destructive');
  const resetActions = actions.filter((a) => tiers.get(a) === 'destructive' && a !== 'delete');
  // The menu closes on select, so the More button shows the action it started while it runs.
  const moreRunning =
    busy && pending !== null && moreActions.includes(pending.action) ? pending.action : null;

  return (
    <article className="mx-auto w-full max-w-[63rem] p-5" data-testid="glob-page">
      <div ref={topRef} aria-hidden className="h-0" />
      <div
        className={`sticky top-0 z-10 -mx-5 -mt-5 mb-4 flex h-10 items-center gap-3 border-b bg-background px-5 ${scrolled ? 'border-border' : 'border-transparent'}`}
        data-testid="glob-header"
      >
        <Tip text="Back to the board (Esc)">
          <Link
            to={`/boards/${String(glob.boardId)}`}
            className="rounded p-1 hover:bg-muted"
            aria-label="Back to the board"
            data-testid="glob-back"
            onClick={(e) => {
              e.preventDefault();
              onClose();
            }}
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Tip>
        <GlobTitle
          id={glob.id}
          title={glob.title}
          editable={glob.status !== 'signed_off'}
          onUpdate={onUpdate}
          onReload={onReload}
        />
      </div>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded bg-muted px-2 py-0.5">
            {(decision ? DECISION_STATUS_TEXT[glob.status] : undefined) ?? STATUS_TEXT[glob.status]}
          </span>
          {decision ? (
            <span className="rounded border px-2 py-0.5 text-xs" data-testid="glob-type">
              decision
            </span>
          ) : (
            <TypePopover
              type={glob.type}
              options={typeChoices}
              busy={busy}
              failure={typeFailure}
              onChange={(option) => run(() => changeType(option))}
            />
          )}
          {glob.group !== null && <GroupChip name={glob.group} />}
          {!decision && <LabelChips glob={glob} />}
          <span className="ml-auto text-xs text-muted-foreground">
            {!decision && (
              <>
                branch{' '}
                {board.repo === null ? (
                  <span className="font-mono">{glob.branch}</span>
                ) : (
                  <a
                    className="font-mono underline-offset-2 hover:underline"
                    href={`https://github.com/${board.repo}/compare/${board.baseBranch}...${glob.branch}`}
                    target="_blank"
                    rel="noreferrer"
                    title={`Compare ${glob.branch} with ${board.baseBranch} on GitHub`}
                  >
                    {glob.branch}
                  </a>
                )}{' '}
                ·{' '}
              </>
            )}
            v{glob.version}
          </span>
        </div>

        {!decision && <NowRow glob={glob} />}
        {status !== null && (
          <p
            className={cn('text-sm font-medium', status.tone)}
            data-testid="status-line"
            data-kind={status.kind}
          >
            {status.full}
            {status.url !== null && (
              <>
                {' ('}
                <a className="underline" href={status.url} target="_blank" rel="noreferrer">
                  check run
                </a>
                )
              </>
            )}
            {status.doing !== null && (
              <span className="font-normal">
                {' — '}
                {status.sessionUrl === null ? (
                  status.doing
                ) : (
                  <a
                    className="underline"
                    href={status.sessionUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {status.doing}
                  </a>
                )}
              </span>
            )}
          </p>
        )}
        <Anchor name="conflict">
          <ConflictSection ctx={ctx} />
        </Anchor>

        <Anchor name="escalation">
          <EscalationSection ctx={ctx} />
        </Anchor>

        <Anchor name="labels">
          {!decision && <LabelReviews glob={glob} onReview={onReviewLabel} openLabel={openLabel} />}
        </Anchor>

        <Anchor name="prerequisites">
          {!decision && (
            <DependenciesSection ctx={ctx} onEditAfter={(after) => edits.edit({ after })} />
          )}
        </Anchor>

        <Anchor name="size">
          <SizeSection
            ctx={ctx}
            decision={decision}
            splitting={splitting}
            onSplitting={setSplitting}
            onClose={onClose}
          />
        </Anchor>

        <Anchor name="actions">
          {brief !== null && (
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
                    onClick={() => setBriefOpen(true)}
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
                        writeHandoverAcknowledged(glob.id, brief);
                        setBriefRead(true);
                        setBriefOpen(false);
                      }}
                    >
                      Got it
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          {(main !== null || actions.length + disabled.length > 0) && (
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2" data-testid="glob-actions">
                {main !== null && (
                  <Tip text={tipOf(main)}>
                    <Button
                      size="sm"
                      disabled={busy}
                      data-testid="main-action"
                      onClick={() => begin(main)}
                    >
                      {actionContent(main)}
                    </Button>
                  </Tip>
                )}
                {moreActions.length + disabled.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        data-testid="more-actions"
                      >
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
                            onSelect={() => begin(action)}
                          >
                            <span className="flex items-center gap-1.5 font-medium">
                              <ActorIcon actor={shown.icon} decorative />
                              {shown.label}
                            </span>
                            <span className="whitespace-pre-line text-xs text-muted-foreground">
                              {tipOf(action)}
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
              {confirmingReady && (
                <div
                  role="alert"
                  className="flex flex-wrap items-center gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
                >
                  <span className="flex-1">
                    No local review is recorded at the PR head: the change_reviewer and /finalise
                    haven't run for {glob.pr?.headSha?.slice(0, 7) ?? 'the head'}. Mark it done
                    anyway?
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingReady(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void markReady()}
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
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingOversized(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    data-testid="confirm-start-oversized"
                    onClick={() =>
                      void run(async () => {
                        const action = confirmingOversized;
                        setConfirmingOversized(null);
                        await onAction(action);
                      })
                    }
                  >
                    {oversized ? 'Start as it is' : 'Continue'}
                  </Button>
                </div>
              )}
              {confirmingRetrigger && (
                <div
                  role="alert"
                  className="flex flex-wrap items-center gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
                >
                  <span className="flex-1" data-testid="retrigger-says">
                    Blocked by {chainTip(glob)}. A run now works without their changes.
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingRetrigger(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    data-testid="confirm-retrigger"
                    onClick={() =>
                      void run(async () => {
                        setConfirmingRetrigger(false);
                        await onAction('retrigger', true);
                      })
                    }
                  >
                    Retry anyway
                  </Button>
                </div>
              )}
              {readyPending && (
                <p role="status" className="text-xs text-muted-foreground">
                  Asked GitHub to mark PR #{glob.pr.number} ready; the glob moves to PR open when
                  GitHub confirms.
                </p>
              )}
            </div>
          )}
        </Anchor>

        <EditFieldsSection
          ctx={ctx}
          decision={decision}
          edits={edits}
          run={run}
          onReload={onReload}
        />

        <Anchor name="plan">
          <PlanSection ctx={ctx} onHistory={() => setArtifact({ kind: 'plan', label: '' })} />
        </Anchor>

        <Anchor name="decision">
          <DecisionPanel ctx={ctx} onDecide={onDecide} applied={applied} />
        </Anchor>

        <Anchor name="deploys">
          <DeploysPanel ctx={ctx} />
        </Anchor>

        <Anchor name="environments">
          <EnvironmentsPanel ctx={ctx} />
        </Anchor>

        <Anchor name="tests">
          <TestsPanel ctx={ctx} />
        </Anchor>

        <Anchor name="artifacts">
          <ArtifactsPanel ctx={ctx} selected={artifact} onSelect={setArtifact} />
        </Anchor>

        <Anchor name="choices">
          <ChoicesPanel ctx={ctx} />
        </Anchor>

        <Anchor name="assessment">
          <DecisionAssessmentPanel ctx={ctx} onApply={setApplied} />
        </Anchor>

        <Anchor name="findings">
          <FindingsPanel ctx={ctx} />
        </Anchor>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <dt>Planner</dt>
          <dd>{glob.planner}</dd>
          <dt>Implementer</dt>
          <dd>{glob.implementer ?? '—'}</dd>
          <dt>Created</dt>
          <dd>{when(glob.createdAt)}</dd>
          {!decision && (
            <>
              <dt>Pull request</dt>
              <dd>
                {glob.pr === null ? (
                  glob.provisioning === 'failed' ? (
                    'provisioning failed; retrying'
                  ) : glob.provisioning === 'none' ? (
                    'opened when work starts'
                  ) : glob.prs.length > 0 ? (
                    'a new one opens on the next push'
                  ) : (
                    'opening…'
                  )
                ) : board.repo === null ? (
                  `#${glob.pr.number} (${glob.pr.state})`
                ) : (
                  <a
                    className="underline"
                    href={`https://github.com/${board.repo}/pull/${glob.pr.number}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    #{glob.pr.number} ({glob.pr.state})
                  </a>
                )}
              </dd>
            </>
          )}
          {glob.prs.length > 0 && (
            <>
              <dt>Merged and continued</dt>
              <dd className="flex flex-wrap gap-x-2">
                {glob.prs.map((p) => (
                  <span key={p.number} title={`${p.mergeSha.slice(0, 7)} · ${when(p.mergedAt)}`}>
                    {board.repo === null ? (
                      `#${p.number}`
                    ) : (
                      <a
                        className="underline"
                        href={`https://github.com/${board.repo}/pull/${p.number}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        #{p.number}
                      </a>
                    )}{' '}
                    <span className="font-mono">{p.mergeSha.slice(0, 7)}</span>
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>

        {glob.runs.length > 0 && (
          <div className="grid gap-1">
            <h3 className="text-xs font-semibold text-muted-foreground">Machine runs</h3>
            {[...glob.runs].reverse().map((run) => (
              <div
                key={run.id}
                className="flex justify-between gap-2 rounded bg-muted px-2 py-1 text-xs"
              >
                <span>
                  {run.purpose === 'investigate' && 'Investigation · '}
                  {run.purpose === 'resolve_conflict' && 'Conflict fix · '}
                  {run.state === 'ended' ? (run.outcome ?? 'ended') : run.state} · owner{' '}
                  {run.routineOwner}
                  {run.sessionUrl !== null && (
                    <>
                      {' · '}
                      <a
                        className="underline"
                        href={run.sessionUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in Claude
                      </a>
                    </>
                  )}
                  {run.failureReason !== null && (
                    <span className="block text-red">{run.failureReason}</span>
                  )}
                </span>
                <span className="text-muted-foreground">
                  queued {when(run.queuedAt)}
                  {run.lastProgressAt !== null && ` · last progress ${when(run.lastProgressAt)}`}
                </span>
              </div>
            ))}
          </div>
        )}

        <div
          className="grid gap-2 rounded border border-destructive/50 p-3"
          data-testid="reset-area"
        >
          <div className="text-xs font-medium text-destructive">Reset</div>
          <div className="flex flex-wrap gap-2">
            {resetActions.map((action) => (
              <Tip key={action} text={tipOf(action)}>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  data-testid={`reset-${action}`}
                  onClick={() => begin(action)}
                >
                  {actionContent(action)}
                </Button>
              </Tip>
            ))}
            {!confirmDelete && (
              <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
                Delete…
              </Button>
            )}
          </div>
          {confirmingAgain && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs"
            >
              <span className="flex-1" data-testid="start-again-says">
                {startAgainConfirmation(glob, board.baseBranch)}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingAgain(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                data-testid="confirm-start-again"
                onClick={() =>
                  void run(async () => {
                    setConfirmingAgain(false);
                    await onAction('start_again');
                  })
                }
              >
                {actionPresentation('start_again', glob).label}
              </Button>
            </div>
          )}
          {confirmDelete && (
            <div className="grid gap-2 rounded border border-destructive/50 p-3 text-sm">
              <p>
                <strong>Delete {glob.id} permanently?</strong> This removes the glob, its branch,
                its PR, its artifacts and its events, so its time leaves the reports. There is no
                archive.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(onDelete)}
                >
                  Delete permanently
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
};
