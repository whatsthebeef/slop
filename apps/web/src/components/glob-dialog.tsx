import { decisionOf, isValidCombination, machine } from '@slop/core';
import type { Action, Category, EditFailure, LabelName, SuggestionPrefill } from '@slop/core';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { actionTiers, orderActions } from '@/lib/action-style';
import { actionPresentation } from '@/lib/action-presentation';
import { ActorIcon, HumanIcon } from '@/components/actor-icons';
import type { BoardView, DecideInput, GlobChanges, GlobView } from '@/lib/api';
import { findSection, scrollWhenReady } from '@/lib/glob-scroll';
import type { GlobSection } from '@/lib/glob-section';
import { workingLabel } from '@/lib/card-pending';
import { PENDING_TIMEOUT_MS, isPending, startAction } from '@/lib/pending-action';
import type { PendingAction } from '@/lib/pending-action';
import { OPEN_OVERLAY, escapeGoesBack } from '@/lib/glob-back';
import { startAgainConfirmation } from '@/lib/start-again';
import { conflictByHand, conflictCommand, copySstorCommand } from '@/lib/sstor-command';
import {
  blockedLine,
  chainTip,
  dependencySummary,
  statusWords,
  viewStatusLine,
  waitingFor,
} from '@/lib/status-line';
import { categoryOptions, saveCategory, typeOptions } from '@/lib/type-change';
import type { TypeOption } from '@/lib/type-change';
import { ArtifactsSection } from './artifacts';
import { DecisionAssessment, DecisionSection } from './decision-section';
import { DeploysSection, EnvironmentsSection, TestsSection } from './deploys';
import type { ArtifactRef } from './artifacts';
import { ActivityLabel, GroupChip } from './glob-card';
import { LabelChips, LabelReviews } from './labels';
import type { ReviewLabel } from './labels';
import { PlanEditor } from './plan-editor';
import { OversizedGlob, isOversized } from './oversized-glob';
import { SplitGlob, canSplit } from './split-glob';
import { GlobDecisions } from './glob-decisions';
import { GlobTitle } from './glob-title';
import { ReviewFindings } from './review-findings';
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

/** The glob view: a page in the board's main area (never a modal), with a back arrow to the board. */
/** The conflict box: the command that starts the glob's Claude session on the merge, with the by-hand route collapsed below. */
const ConflictBox = ({
  globId,
  branch,
  base,
  canTakeOver,
}: {
  globId: string;
  branch: string;
  base: string;
  canTakeOver: boolean;
}) => {
  const command = conflictCommand(globId, canTakeOver);
  const copy = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    void (
      copySstorCommand(canTakeOver ? 'take_over' : 'pick_up', globId, clipboard) ??
      Promise.resolve(null)
    );
  };
  return (
    <div className="grid gap-1 rounded border border-edge p-2 text-sm" data-testid="conflict-box">
      <span>
        {canTakeOver ? 'Pick up and let your Claude session' : 'Let your Claude session'} merge{' '}
        {base}: it resolves additive conflicts and asks you about the rest.
      </span>
      <span className="flex items-center gap-2">
        <code
          className="block select-all whitespace-pre-wrap font-mono text-xs"
          data-testid="conflict-command"
        >
          {command}
        </code>
        <button
          type="button"
          className="rounded border px-1.5 py-0.5 text-xs hover:bg-muted"
          onClick={copy}
        >
          Copy
        </button>
      </span>
      <details data-testid="conflict-by-hand">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Resolve by hand instead (advanced)
        </summary>
        <code className="block whitespace-pre-wrap font-mono text-xs">
          {conflictByHand(globId, branch, base)}
        </code>
      </details>
    </div>
  );
};

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
  const [draft, setDraft] = useState<GlobChanges>({});
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
  const [failure, setFailure] = useState<EditFailure | null>(null);
  useEffect(() => {
    setDraft({});
    setFailure(null);
    setConfirmingAgain(false);
    setTypeFailure(null);
    setCategoryNote(null);
  }, [glob.id]);
  /** Edits the draft; a refusal shown earlier no longer applies to what the person is typing. */
  const edit = (changes: GlobChanges) => {
    setDraft((d) => ({ ...d, ...changes }));
    setFailure(null);
  };
  const [confirmingRetrigger, setConfirmingRetrigger] = useState(false);
  // The type chip's popover says what follows before it changes the type.
  const [typeFailure, setTypeFailure] = useState<EditFailure | null>(null);
  const typeChoices = typeOptions(glob, board.role);
  // Category saves when it changes, and says so with an Undo.
  const [categoryNote, setCategoryNote] = useState<{ undo: Category } | null>(null);
  const changeCategory = async (to: Category, from: Category) => {
    const result = await saveCategory(onUpdate, from, to);
    if (result.saved) {
      setFailure(null);
      setCategoryNote({ undo: result.undo });
    } else {
      setFailure(result.failure);
      setCategoryNote(null);
    }
  };
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

  // The globs it waits for can change until it has a branch.
  const canEditAfter =
    glob.status === 'planning' && glob.provisioning === 'none' && glob.type !== 'super';
  const [afterText, setAfterText] = useState((glob.after ?? []).join(', '));
  const [showChain, setShowChain] = useState(false);
  const summary = dependencySummary(glob);
  const deps =
    summary !== null || canEditAfter
      ? (summary ?? { needs: [], alsoAhead: [], overlaps: [], waitedOnBy: [] })
      : null;
  useEffect(() => setAfterText((glob.after ?? []).join(', ')), [glob.id, glob.after]);
  const merged = { ...glob, ...draft };
  const dirty = Object.keys(draft).length > 0;
  const [splitting, setSplitting] = useState(false);
  useEffect(() => setSplitting(false), [glob.id]);
  const oversized = isOversized(glob);
  const splittable = canSplit(glob) && (glob.allowedActions ?? []).includes('delete') && !oversized;
  // Starting a flagged glob asks first: it is likely more than one PR's worth of work.
  const [confirmingOversized, setConfirmingOversized] = useState<Action | null>(null);
  useEffect(() => setConfirmingOversized(null), [glob.id]);
  // Decide has its own panel with the five outcomes.
  // deescalate and make_super are reached through the type popover.
  const allActions = (glob.allowedActions ?? []).filter(
    (a) => a !== 'delete' && a !== 'decide' && actionPresentation(a, glob).placement !== 'none',
  );
  const actions = orderActions(allActions);
  const tiers = actionTiers(allActions);
  const disabled = waitingFor(glob, actions, board.role);
  const status = viewStatusLine(glob, new Date().toISOString(), disabled);
  // Done changes nothing until GitHub confirms, so say it was asked for meanwhile.
  const [readyAsked, setReadyAsked] = useState(false);
  const readyPending = readyAsked && glob.status === 'in_progress' && glob.pr?.state === 'draft';
  // A super's local review normally comes first (/finalise); the board warns, then allows.
  const [confirmingReady, setConfirmingReady] = useState(false);
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
  const deployable = board.environments.filter((e) => e.allowBranchDeploy);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const renderActions = (list: Action[]) =>
    list.map((action) => {
      const shown = actionPresentation(action, glob);
      const button = (
        <Button
          key={action}
          variant={
            tiers.get(action) === 'primary'
              ? 'default'
              : tiers.get(action) === 'destructive'
                ? 'danger'
                : 'outline'
          }
          size="sm"
          disabled={busy}
          onClick={() => {
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
              oversized &&
              (action === 'start' ||
                action === 'start_anyway' ||
                action === 'pick_up' ||
                action === 'take_over')
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
          }}
        >
          {busy && pending?.action === action ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {workingLabel(action)}
            </>
          ) : (
            <>
              <ActorIcon actor={shown.icon} decorative />
              {shown.label}
            </>
          )}
        </Button>
      );
      return (
        <Tip key={action} text={shown.tip}>
          {button}
        </Tip>
      );
    });

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
          <ActivityLabel glob={glob} />
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
          {(glob.failure?.conflict ?? glob.conflict) != null && glob.implementer !== null && (
            <ConflictBox
              globId={glob.id}
              branch={glob.branch}
              base={(glob.failure?.conflict ?? glob.conflict)?.base ?? ''}
              canTakeOver={(glob.allowedActions ?? []).includes('take_over')}
            />
          )}
        </Anchor>

        <Anchor name="escalation">
          {glob.escalation != null && (
            <div
              className="grid gap-1 rounded border border-edge p-2 text-sm"
              data-testid="escalation-note"
            >
              <span>
                <span className="sr-only">Needs a person: {glob.escalation.reason}</span>
                <span
                  aria-hidden
                  title={`Needs a person: ${glob.escalation.reason}`}
                  className="inline-flex items-center gap-1"
                >
                  needs a <HumanIcon decorative />: {glob.escalation.reason}
                </span>
              </span>
              {glob.escalation.evidence !== undefined && (
                <span className="text-xs text-muted-foreground">{glob.escalation.evidence}</span>
              )}
              <span className="text-xs text-muted-foreground">
                Escalated by {glob.escalation.by}
              </span>
            </div>
          )}
        </Anchor>

        <Anchor name="labels">
          {!decision && <LabelReviews glob={glob} onReview={onReviewLabel} openLabel={openLabel} />}
        </Anchor>

        <Anchor name="prerequisites">
          {!decision && deps !== null && (
            <div className="grid gap-2 rounded border p-2 text-sm" data-testid="dependencies">
              <span className="font-medium">Dependencies</span>
              {blockedLine(glob) !== null && (
                <span className="text-xs text-muted-foreground">{blockedLine(glob)}</span>
              )}
              {deps.needs.length > 0 && (
                <div data-testid="waits-for">
                  <span className="font-medium">Waits for</span>
                  <ul className="ml-4 list-disc">
                    {deps.needs.map((n) => (
                      <li key={n.id}>
                        <GlobLink boardId={glob.boardId} id={n.id} />
                        {n.status !== null && (
                          <span className="text-muted-foreground"> · {n.status}</span>
                        )}{' '}
                        <span className="text-muted-foreground">{n.why}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {deps.alsoAhead.length > 0 && (
                <div data-testid="also-ahead">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline"
                    aria-expanded={showChain}
                    onClick={() => setShowChain(!showChain)}
                  >
                    {showChain ? '▾' : '▸'} {deps.alsoAhead.length} more ahead
                  </button>
                  {showChain && (
                    <ul className="ml-4 list-disc">
                      {deps.alsoAhead.map((b) => (
                        <li key={b.id} style={{ marginLeft: `${String((b.depth - 2) * 12)}px` }}>
                          <GlobLink boardId={glob.boardId} id={b.id} />{' '}
                          <span className="text-muted-foreground">· {statusWords(b.status)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {deps.overlaps.length > 0 && (
                <div data-testid="overlaps">
                  <span className="font-medium">Overlaps</span>{' '}
                  <span className="text-xs text-muted-foreground">
                    merge order only; never blocks
                  </span>
                  <ul className="ml-4 list-disc">
                    {deps.overlaps.map((o) => (
                      <li key={o.id}>
                        <GlobLink boardId={glob.boardId} id={o.id} />
                        {o.paths.length > 0 && (
                          <span className="text-muted-foreground"> · {o.paths.join(', ')}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {deps.waitedOnBy.length > 0 && (
                <div data-testid="waited-on-by">
                  <span className="font-medium">Waited on by</span>{' '}
                  {deps.waitedOnBy.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ', '}
                      <GlobLink boardId={glob.boardId} id={id} />
                    </span>
                  ))}
                </div>
              )}
              {canEditAfter && (
                <Label>
                  Waits for (glob IDs)
                  <Input
                    value={afterText}
                    placeholder="s15t7, s15b18"
                    onChange={(e) => {
                      setAfterText(e.target.value);
                      edit({ after: e.target.value.split(/[\s,]+/).filter((id) => id !== '') });
                    }}
                  />
                </Label>
              )}
              {(glob.blockedBy?.length ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">
                  Picking it up goes ahead without them: the branch will lack their changes.
                </p>
              )}
            </div>
          )}
        </Anchor>

        <Anchor name="size">
          {!decision && splittable && !splitting && (
            <div>
              <Tip text="Cut this glob into parts: part 1 stays here, the others are created with their share of the plan">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  data-testid="split-glob"
                  onClick={() => setSplitting(true)}
                >
                  Split
                </Button>
              </Tip>
            </div>
          )}
          {!decision && oversized && (
            <OversizedGlob
              glob={glob}
              canKeep={board.role !== 'qa' || glob.type === 'sub'}
              onDone={() => onClose()}
            />
          )}
          {splitting && (
            <SplitGlob glob={glob} onCancel={() => setSplitting(false)} onDone={() => onClose()} />
          )}
        </Anchor>

        <Anchor name="actions">
          {actions.length + disabled.length > 0 && (
            <div className="grid gap-1">
              <div className="flex flex-wrap gap-2">
                {renderActions(actions.filter((a) => tiers.get(a) !== 'destructive'))}
                {disabled.map(({ action, label, icon, tip }) => (
                  <Tip key={action} text={tip}>
                    <Button variant="outline" size="sm" disabled>
                      <ActorIcon actor={icon} decorative />
                      {label}
                    </Button>
                  </Tip>
                ))}
                {renderActions(actions.filter((a) => tiers.get(a) === 'destructive'))}
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
                    This glob is flagged oversized: it is probably more than one PR's worth of work.
                    Split it, or start it as it is?
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
                   Start as it is
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
              {readyPending && (
                <p role="status" className="text-xs text-muted-foreground">
                  Asked GitHub to mark PR #{glob.pr.number} ready; the glob moves to PR open when
                  GitHub confirms.
                </p>
              )}
            </div>
          )}
        </Anchor>

        <div className="grid gap-3">
          <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-3">
            {!decision && (
              <Label>
                Category
                <Select
                  value={glob.category}
                  disabled={busy}
                  data-testid="category"
                  onChange={(e) =>
                    void run(() => changeCategory(e.target.value as Category, glob.category))
                  }
                >
                  {categoryOptions(glob.type).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Label>
            )}
            <Label>
              Group
              <Input
                value={merged.group ?? ''}
                onChange={(e) => edit({ group: e.target.value === '' ? null : e.target.value })}
              />
            </Label>
            {!decision && (
              <Label>
                Environment
                <Select
                  value={merged.environment ?? ''}
                  onChange={(e) =>
                    edit({ environment: e.target.value === '' ? null : e.target.value })
                  }
                >
                  <option value="">None</option>
                  {deployable.map((env) => (
                    <option key={env.name}>{env.name}</option>
                  ))}
                </Select>
              </Label>
            )}
          </div>
          {categoryNote !== null && failure === null && (
            <div
              role="status"
              className="flex items-center justify-end gap-2 text-xs text-muted-foreground"
              data-testid="category-saved"
            >
              <span>Saved</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    changeCategory(categoryNote.undo, glob.category).then(() =>
                      setCategoryNote(null),
                    ),
                  )
                }
              >
                Undo
              </Button>
            </div>
          )}
          {failure !== null && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-end gap-2 text-sm text-red"
            >
              <span>{failure.message}</span>
              {failure.conflict && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await onReload();
                      setFailure(null);
                    })
                  }
                >
                  Reload latest
                </Button>
              )}
            </div>
          )}
          {dirty && (
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraft({});
                  setFailure(null);
                }}
              >
                Discard
              </Button>
              <Button
                size="sm"
                disabled={busy || !isValidCombination(merged.type, merged.category)}
                onClick={() =>
                  void run(async () => {
                    const refused = await onUpdate(draft);
                    setFailure(refused);
                    if (refused === null) setDraft({});
                  })
                }
              >
                Save
              </Button>
            </div>
          )}
        </div>

        <Anchor name="plan">
          <PlanEditor
            globId={glob.id}
            startExpanded={new URLSearchParams(window.location.search).get('section') === 'plan'}
            onHistory={
              glob.status === 'signed_off'
                ? undefined
                : () => setArtifact({ kind: 'plan', label: '' })
            }
          />
        </Anchor>

        <Anchor name="decision">
          {decision && (
            <DecisionSection
              board={board}
              glob={glob}
              busy={busy}
              onDecide={onDecide}
              onUpdate={onUpdate}
              applied={applied}
            />
          )}
        </Anchor>

        {!decision && (
          <>
            <Anchor name="deploys">
              <DeploysSection board={board} glob={glob} />
            </Anchor>

            <Anchor name="environments">
              <EnvironmentsSection board={board} glob={glob} />
            </Anchor>

            <Anchor name="tests">
              <TestsSection glob={glob} />
            </Anchor>
          </>
        )}

        <Anchor name="artifacts">
          <ArtifactsSection
            globId={glob.id}
            boardId={glob.boardId}
            artifacts={glob.artifacts ?? []}
            signedOff={glob.status === 'signed_off'}
            selected={artifact}
            onSelect={setArtifact}
          />
        </Anchor>

        <Anchor name="choices">
          <GlobDecisions boardId={glob.boardId} globId={glob.id} />
        </Anchor>

        <Anchor name="assessment">
          {decision && decisionOf(glob)?.origin.kind !== 'replacement' && (
            <DecisionAssessment
              glob={glob}
              canSuggest={board.role === 'admin' || board.role === 'po'}
              onApply={setApplied}
            />
          )}
        </Anchor>

        <Anchor name="findings">
          {!decision && (
            <ReviewFindings
              globId={glob.id}
              startOpen={new URLSearchParams(window.location.search).get('section') === 'findings'}
            />
          )}
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

        <div className="border-t pt-3">
          {confirmDelete ? (
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
          ) : (
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete…
            </Button>
          )}
        </div>
      </div>
    </article>
  );
};

const GlobLink = ({ boardId, id }: { boardId: number; id: string }) => (
  <Link
    to={`/boards/${String(boardId)}?glob=${encodeURIComponent(id)}`}
    className="font-mono underline"
  >
    {id}
  </Link>
);
