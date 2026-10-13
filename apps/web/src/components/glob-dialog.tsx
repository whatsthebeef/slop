import { isValidCombination } from '@slop/core';
import type { Action, Category, EditFailure, LabelName, SuggestionPrefill } from '@slop/core';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { HumanIcon } from '@/components/actor-icons';
import type { BoardView, DecideInput, GlobChanges, GlobView } from '@/lib/api';
import { findSection, scrollWhenReady } from '@/lib/glob-scroll';
import type { GlobSection } from '@/lib/glob-section';
import { OPEN_OVERLAY, escapeGoesBack } from '@/lib/glob-back';
import { conflictByHand, conflictCommand, copySstorCommand } from '@/lib/sstor-command';
import { blockedLine, dependencySummary, statusWords, viewStatusLine } from '@/lib/status-line';
import { categoryOptions, saveCategory } from '@/lib/type-change';
import type { ArtifactRef } from './artifacts';
import { moveOf, positionOf, stepLabel, stepsOf, stepWords } from '@/lib/position';
import { LabelReviews } from './labels';
import type { ReviewLabel } from './labels';
import { OversizedGlob } from './oversized-glob';
import { SplitGlob, canSplit } from './split-glob';
import { HumanSteps } from './human-steps';
import { GlobActions, GlobReset, useGlobActions } from './glob-view/actions';
import { ArtifactsPanel } from './glob-view/artifacts';
import { ChoicesPanel } from './glob-view/choices';
import type { GlobViewContext } from './glob-view/context';
import { DecisionAssessmentPanel, DecisionPanel } from './glob-view/decision';
import { DeploysPanel } from './glob-view/deploys';
import { EnvironmentsPanel } from './glob-view/environments';
import { FindingsPanel } from './glob-view/findings';
import { GlobChips, GlobHeader } from './glob-view/header';
import { PlanSection } from './glob-view/plan';
import { TestsPanel } from './glob-view/tests';
import { cn } from '@/lib/utils';
import { Tip } from './ui/tip';

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
        : { human: 'Their turn', machine: 'Machine', waiting: 'Waiting', stalled: 'Stalled' }[
            position.holder
          ];
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
                {stepLabel(step)}{' '}
                <span className="text-muted-foreground">{stepWords(step, now)}</span>
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

export const GlobDetail = ({
  board,
  glob,
  initialArtifact,
  section = null,
  openLabel = null,
  onClose,
  onUpdate,
  onReload,
  email,
  onAddStep,
  onCompleteStep,
  onDismissStep,
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
  /** Who is looking, for the steps that are theirs (unknown until /api/me has answered). */
  email?: string;
  /** Human steps: each resolves false when it failed (the page shows why); the glob is replaced afterwards. */
  onAddStep: (step: {
    title: string;
    detail?: string;
    who?: string;
    due?: string;
  }) => Promise<boolean>;
  onCompleteStep: (stepId: string) => Promise<boolean>;
  onDismissStep: (stepId: string, reason: string) => Promise<boolean>;
  /** Resolves false when the action failed. */
  /** `anyway` goes ahead of unmerged prerequisites (Retry). */
  onAction: (action: Action, anyway?: boolean) => Promise<boolean>;
  onReviewLabel: ReviewLabel;
  /** Decision globs: the outcome chosen in Doing; resolves false when it failed. */
  onDecide: (input: DecideInput) => Promise<boolean>;
  onDelete: () => Promise<void>;
}) => {
  const actionState = useGlobActions({
    board,
    glob,
    onAction,
    onUpdate,
    ...(email === undefined ? {} : { email }),
  });
  const { decision, busy, run, oversized, disabled, viewer, stepsSignal } = actionState;
  const [draft, setDraft] = useState<GlobChanges>({});
  const [artifact, setArtifact] = useState<ArtifactRef | null>(initialArtifact);
  // Suggest's Apply: the decision form opens pre-filled; reset when another glob opens.
  const [applied, setApplied] = useState<SuggestionPrefill | null>(null);
  useEffect(() => setApplied(null), [glob.id]);
  const [failure, setFailure] = useState<EditFailure | null>(null);
  useEffect(() => {
    setDraft({});
    setFailure(null);
    setCategoryNote(null);
  }, [glob.id]);
  /** Edits the draft; a refusal shown earlier no longer applies to what the person is typing. */
  const edit = (changes: GlobChanges) => {
    setDraft((d) => ({ ...d, ...changes }));
    setFailure(null);
  };
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
  useEffect(() => setArtifact(initialArtifact), [glob.id, initialArtifact]);
  // Once per navigation (glob or section), not on the live refreshes that re-render the page.
  useEffect(() => {
    if (section === null) return undefined;
    return scrollWhenReady(() => findSection(document, section));
  }, [glob.id, section]);
  const ctx: GlobViewContext = {
    board,
    glob,
    busy,
    onAction,
    onUpdate,
    onOpenSection: (target) => {
      const { section: to } = target;
      if (to !== undefined) scrollWhenReady(() => findSection(document, to));
    },
  };

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
  const splittable = canSplit(glob) && (glob.allowedActions ?? []).includes('delete') && !oversized;
  const status = viewStatusLine(glob, new Date().toISOString(), disabled);
  // Esc goes back to the board, unless typing, an overlay or an inline confirmation owns it.
  const confirming = actionState.confirmDelete || actionState.confirmingAgain || splitting;
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
  const deployable = board.environments.filter((e) => e.allowBranchDeploy);

  return (
    <article className="mx-auto w-full max-w-[63rem] p-5" data-testid="glob-page">
      <GlobHeader ctx={ctx} onClose={onClose} onReload={onReload} />
      <div className="grid gap-4">
        <GlobChips ctx={ctx} actions={actionState} />

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
          <GlobActions ctx={ctx} state={actionState} />
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

        <Anchor name="human-steps">
          <HumanSteps
            glob={glob}
            {...(viewer === undefined ? {} : { viewer })}
            canAdd
            startOpen={section === 'human-steps'}
            openSignal={stepsSignal}
            onAdd={onAddStep}
            onComplete={onCompleteStep}
            onDismiss={onDismissStep}
          />
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

        <GlobReset ctx={ctx} state={actionState} onDelete={onDelete} />
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
