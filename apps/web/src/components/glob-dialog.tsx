import type { Action, EditFailure, LabelName, SuggestionPrefill } from '@slop/core';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BoardView, DecideInput, GlobChanges, GlobView } from '@/lib/api';
import { findSection, scrollWhenReady } from '@/lib/glob-scroll';
import type { GlobSection } from '@/lib/glob-section';
import { OPEN_OVERLAY, escapeGoesBack } from '@/lib/glob-back';
import { viewStatusLine } from '@/lib/status-line';
import { ConflictSection } from './glob-view/conflict';
import { DependenciesSection } from './glob-view/dependencies';
import { EditFieldsSection, useGlobEdits } from './glob-view/edit-fields';
import { EscalationSection } from './glob-view/escalation';
import { SizeSection } from './glob-view/size';
import type { ArtifactRef } from './artifacts';
import { moveOf, positionOf, stepLabel, stepsOf, stepWords } from '@/lib/position';
import { LabelReviews } from './labels';
import type { ReviewLabel } from './labels';
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
  const { decision, busy, run, disabled, viewer, stepsSignal } = actionState;
  const edits = useGlobEdits(glob.id);
  const [artifact, setArtifact] = useState<ArtifactRef | null>(initialArtifact);
  // Suggest's Apply: the decision form opens pre-filled; reset when another glob opens.
  const [applied, setApplied] = useState<SuggestionPrefill | null>(null);
  useEffect(() => setApplied(null), [glob.id]);
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

  const [splitting, setSplitting] = useState(false);
  useEffect(() => setSplitting(false), [glob.id]);
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
          <GlobActions ctx={ctx} state={actionState} />
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
