import { decisionOf } from '@slop/core';
import type { Action, EditFailure, LabelName } from '@slop/core';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AddRelationInput, BoardView, DecideInput, GlobChanges, GlobView } from '@/lib/api';
import { findSection, scrollWhenReady } from '@/lib/glob-scroll';
import type { GlobSection } from '@/lib/glob-section';
import { OPEN_OVERLAY, escapeGoesBack } from '@/lib/glob-back';
import type { ArtifactRef } from './artifacts';
import type { ReviewLabel } from './labels';
import { isLearning, useDecideFlow } from './decision-outcomes';
import { GlobReset, useGlobActions } from './glob-view/actions';
import type { GlobViewContext } from './glob-view/context';
import { useGlobEdits } from './glob-view/edit-fields';
import { GlobChips, GlobHeader } from './glob-view/header';
import { GlobMeta } from './glob-view/meta';
import { AFTER_SECTION, SECTION_VIEWS } from './glob-view/section-views';
import { DECISION_VIEW_SECTIONS, GLOB_VIEW_SECTIONS, LEARNING_VIEW_SECTIONS } from './glob-view/sections';
import { useNowState } from './glob-view/status';
import { GlobTitle } from './glob-title';
import { isOversized, useOversized } from './oversized-glob';

/** A section's anchor: found by `?section=`, and left below the sticky header (its measured height) when scrolled to. Hidden while empty. */
const Anchor = ({ name, children }: { name: GlobSection; children: ReactNode }) => (
  <div id={`section-${name}`} data-section={name} className="scroll-mt-[calc(var(--glob-header-height,2.25rem)+0.5rem)] empty:hidden">
    {children}
  </div>
);

/** The glob view: a page in the board's main area (never a modal), with a back arrow to the board. */
export const GlobDetail = ({
  board,
  glob,
  groups = [],
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
  onDismissEdge,
  onAddRelation,
  onDismiss,
  onDecide,
  onDelete,
}: {
  board: BoardView;
  glob: GlobView;
  /** The board's existing groups, suggested in the Group field. */
  groups?: readonly string[];
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
  /** The ✕ on a Related row: the relation is not a dependency; resolves false when it failed. */
  onDismissEdge: (relationId: string) => Promise<boolean>;
  /** "Add relation…" (and a decision's "Holds back…"); resolves false when it failed. */
  onAddRelation: (input: AddRelationInput) => Promise<boolean>;
  /** "Got it" / ×: dismisses a status message for the viewer (`dismiss` false is Show again); resolves false when it failed. */
  onDismiss: (key: string, dismiss: boolean) => Promise<boolean>;
  /** Decision globs: the outcome chosen in Doing; resolves false when it failed. */
  onDecide: (input: DecideInput) => Promise<boolean>;
  onDelete: () => Promise<void>;
}) => {
  const actionState = useGlobActions({
    board,
    glob,
    onAction,
    onUpdate,
    onDismiss,
    onCompleteStep,
    ...(email === undefined ? {} : { email }),
  });
  const { decision, busy, disabled } = actionState;
  const decide = useDecideFlow({ board, glob, busy, onDecide });
  // A learning has its own, shorter view (see LEARNING_VIEW_SECTIONS).
  const attributes = decisionOf(glob);
  const learning = attributes !== null && isLearning(attributes);
  const nowState = useNowState(glob, decision, disabled, actionState);
  const edits = useGlobEdits(glob.id);
  const [artifact, setArtifact] = useState<ArtifactRef | null>(initialArtifact);
  useEffect(() => setArtifact(initialArtifact), [glob.id, initialArtifact]);
  // Once per navigation (glob or section), not on the live refreshes that re-render the page.
  useEffect(() => {
    if (section === null) return undefined;
    return scrollWhenReady(() => findSection(document, section));
  }, [glob.id, section]);
  const ctx: GlobViewContext = {
    board,
    glob,
    groups,
    busy,
    onAction,
    onUpdate,
    decide,
    onOpenSection: (target) => {
      const { section: to } = target;
      if (to !== undefined) scrollWhenReady(() => findSection(document, to));
    },
  };

  const [splitting, setSplitting] = useState(false);
  const size = useOversized({ glob, enabled: !actionState.decision && isOversized(glob) });
  useEffect(() => setSplitting(false), [glob.id]);
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

  const sectionProps = {
    ctx,
    actions: actionState,
    nowState,
    edits,
    section,
    openLabel,
    artifact,
    onSelectArtifact: setArtifact,
    size,
    splitting,
    onSplitting: setSplitting,
    onClose,
    onReload,
    onReviewLabel,
    onDismissEdge,
    onAddRelation,
    onAddStep,
    onCompleteStep,
    onDismissStep,
  };

  return (
    <article className="mx-auto w-full min-w-0 max-w-[63rem] overflow-x-clip p-5" data-testid="glob-page">
      <GlobHeader ctx={ctx} onClose={onClose} state={nowState} actions={actionState} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <GlobTitle
          id={glob.id}
          title={glob.title}
          editable={glob.status !== 'signed_off'}
          onUpdate={onUpdate}
          onReload={onReload}
        />
        <GlobChips ctx={ctx} />
        {(learning ? LEARNING_VIEW_SECTIONS : decision ? DECISION_VIEW_SECTIONS : GLOB_VIEW_SECTIONS).map((name) => (
          <Fragment key={name}>
            <Anchor name={name}>{SECTION_VIEWS[name](sectionProps)}</Anchor>
            {learning && name === 'actions' ? null : AFTER_SECTION[name]?.(sectionProps)}
          </Fragment>
        ))}
        {learning && AFTER_SECTION.actions?.(sectionProps)}
        <GlobMeta ctx={ctx} />
        <GlobReset ctx={ctx} state={actionState} onDelete={onDelete} />
      </div>
    </article>
  );
};
