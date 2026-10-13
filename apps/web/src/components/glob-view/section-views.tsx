import type { LabelName, SuggestionPrefill } from '@slop/core';
import type { ReactNode } from 'react';
import type { DecideInput } from '@/lib/api';
import type { GlobSection } from '@/lib/glob-section';
import type { ArtifactRef } from '../artifacts';
import { HumanSteps } from '../human-steps';
import { LabelReviews } from '../labels';
import type { ReviewLabel } from '../labels';
import { GlobActions } from './actions';
import type { GlobActionsState } from './actions';
import { ArtifactsPanel } from './artifacts';
import { ChoicesPanel } from './choices';
import { ConflictSection } from './conflict';
import type { GlobViewContext } from './context';
import { DecisionAssessmentPanel, DecisionPanel } from './decision';
import { DependenciesSection } from './dependencies';
import { DeploysPanel } from './deploys';
import { EditFieldsSection } from './edit-fields';
import type { GlobEdits } from './edit-fields';
import { EnvironmentsPanel } from './environments';
import { EscalationSection } from './escalation';
import { FindingsPanel } from './findings';
import { PlanSection } from './plan';
import { SizeSection } from './size';
import { TestsPanel } from './tests';

/** What the glob page hands every section's view: the shared context, the shared state and the page's callbacks. */
export interface SectionProps {
  ctx: GlobViewContext;
  actions: GlobActionsState;
  edits: GlobEdits;
  /** The `?section=` the page opened at. */
  section: GlobSection | null;
  openLabel: LabelName | null;
  artifact: ArtifactRef | null;
  onSelectArtifact: (artifact: ArtifactRef | null) => void;
  /** Suggest's Apply: the decision form opens pre-filled. */
  applied: SuggestionPrefill | null;
  onApply: (prefill: SuggestionPrefill | null) => void;
  splitting: boolean;
  onSplitting: (splitting: boolean) => void;
  onClose: () => void;
  onReload: () => Promise<void>;
  onReviewLabel: ReviewLabel;
  onDecide: (input: DecideInput) => Promise<boolean>;
  onAddStep: (step: {
    title: string;
    detail?: string;
    who?: string;
    due?: string;
  }) => Promise<boolean>;
  onCompleteStep: (stepId: string) => Promise<boolean>;
  onDismissStep: (stepId: string, reason: string) => Promise<boolean>;
}

/** Renders one section of the glob page (the content inside its anchor). */
type SectionView = (props: SectionProps) => ReactNode;

/** How each section renders, keyed by its `data-section` id. The order lives in `sections.ts`. */
export const SECTION_VIEWS: Record<GlobSection, SectionView> = {
  conflict: ({ ctx }) => <ConflictSection ctx={ctx} />,
  escalation: ({ ctx }) => <EscalationSection ctx={ctx} />,
  labels: ({ ctx, actions, onReviewLabel, openLabel }) =>
    !actions.decision && (
      <LabelReviews glob={ctx.glob} onReview={onReviewLabel} openLabel={openLabel} />
    ),
  prerequisites: ({ ctx, actions, edits }) =>
    !actions.decision && (
      <DependenciesSection ctx={ctx} onEditAfter={(after) => edits.edit({ after })} />
    ),
  size: ({ ctx, actions, splitting, onSplitting, onClose }) => (
    <SizeSection
      ctx={ctx}
      decision={actions.decision}
      splitting={splitting}
      onSplitting={onSplitting}
      onClose={onClose}
    />
  ),
  actions: ({ ctx, actions }) => <GlobActions ctx={ctx} state={actions} />,
  plan: ({ ctx, onSelectArtifact }) => (
    <PlanSection ctx={ctx} onHistory={() => onSelectArtifact({ kind: 'plan', label: '' })} />
  ),
  decision: ({ ctx, onDecide, applied }) => (
    <DecisionPanel ctx={ctx} onDecide={onDecide} applied={applied} />
  ),
  deploys: ({ ctx }) => <DeploysPanel ctx={ctx} />,
  environments: ({ ctx }) => <EnvironmentsPanel ctx={ctx} />,
  tests: ({ ctx }) => <TestsPanel ctx={ctx} />,
  'human-steps': ({ ctx, actions, section, onAddStep, onCompleteStep, onDismissStep }) => (
    <HumanSteps
      glob={ctx.glob}
      {...(actions.viewer === undefined ? {} : { viewer: actions.viewer })}
      canAdd
      startOpen={section === 'human-steps'}
      openSignal={actions.stepsSignal}
      onAdd={onAddStep}
      onComplete={onCompleteStep}
      onDismiss={onDismissStep}
    />
  ),
  artifacts: ({ ctx, artifact, onSelectArtifact }) => (
    <ArtifactsPanel ctx={ctx} selected={artifact} onSelect={onSelectArtifact} />
  ),
  choices: ({ ctx }) => <ChoicesPanel ctx={ctx} />,
  assessment: ({ ctx, onApply }) => <DecisionAssessmentPanel ctx={ctx} onApply={onApply} />,
  findings: ({ ctx }) => <FindingsPanel ctx={ctx} />,
};

/** Sections that render after another one's anchor without an anchor of their own (the edit fields, under the actions). */
export const AFTER_SECTION: Partial<Record<GlobSection, SectionView>> = {
  actions: ({ ctx, actions, edits, onReload }) => (
    <EditFieldsSection
      ctx={ctx}
      decision={actions.decision}
      edits={edits}
      run={actions.run}
      onReload={onReload}
    />
  ),
};
