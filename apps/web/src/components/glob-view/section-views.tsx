import type { LabelName } from '@slop/core';
import type { ReactNode } from 'react';
import type { AddRelationInput } from '@/lib/api';
import type { GlobSection } from '@/lib/glob-section';
import type { ArtifactRef } from '../artifacts';
import { HumanSteps } from '../human-steps';
import { LabelReviews } from '../labels';
import type { ReviewLabel } from '../labels';
import { ActionOutcome } from './action';
import { ActivityLog } from './activity';
import { GlobActions } from './actions';
import type { GlobActionsState } from './actions';
import { ArtifactsPanel } from './artifacts';
import { ChoicesPanel } from './choices';
import { ConflictSection } from './conflict';
import type { GlobViewContext } from './context';
import { DecisionAssessmentPanel, DecisionHoldsBack, DecisionPanel } from './decision';
import { DeploysPanel } from './deploys';
import { EditFieldsSection } from './edit-fields';
import type { GlobEdits } from './edit-fields';
import { EnvironmentsPanel } from './environments';
import { EscalationSection } from './escalation';
import { FindingsPanel } from './findings';
import { PlanSection } from './plan';
import { ProblemSection } from './problem';
import { RelatedSection } from './related';
import { SizeSection } from './size';
import type { OversizedState } from '../oversized-glob';
import type { NowState } from './status';
import { TestsPanel } from './tests';

/** What the glob page hands every section's view: the shared context, the shared state and the page's callbacks. */
export interface SectionProps {
  ctx: GlobViewContext;
  actions: GlobActionsState;
  /** The status worked out once for the header and the Activity log. */
  nowState: NowState;
  edits: GlobEdits;
  /** The `?section=` the page opened at. */
  section: GlobSection | null;
  openLabel: LabelName | null;
  artifact: ArtifactRef | null;
  onSelectArtifact: (artifact: ArtifactRef | null) => void;
  /** The size check's advice (the proposed workstreams), read by the size panel. */
  size: OversizedState;
  splitting: boolean;
  onSplitting: (splitting: boolean) => void;
  onClose: () => void;
  onReload: () => Promise<void>;
  onReviewLabel: ReviewLabel;
  onDismissEdge: (relationId: string) => Promise<boolean>;
  onAddRelation: (input: AddRelationInput) => Promise<boolean>;
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
  problem: ({ ctx, nowState, actions }) => <ProblemSection ctx={ctx} state={nowState} actions={actions} />,
  escalation: ({ ctx, section }) => (
    <EscalationSection ctx={ctx} startOpen={section === 'escalation'} />
  ),
  labels: ({ ctx, actions, onReviewLabel, openLabel }) =>
    !actions.human && (
      <LabelReviews glob={ctx.glob} onReview={onReviewLabel} openLabel={openLabel} />
    ),
  related: ({ ctx, actions, onDismissEdge, onAddRelation }) =>
    actions.human ? (
      <DecisionHoldsBack ctx={ctx} onAddRelation={onAddRelation} />
    ) : (
      <RelatedSection ctx={ctx} onDismissEdge={onDismissEdge} onAddRelation={onAddRelation} />
    ),
  size: ({ ctx, actions, size, splitting, onSplitting, onClose }) => (
    <SizeSection
      ctx={ctx}
      decision={actions.human}
      size={size}
      splitting={splitting}
      onSplitting={onSplitting}
      onClose={onClose}
    />
  ),
  actions: ({ ctx, actions, onSplitting }) => (
    <GlobActions ctx={ctx} state={actions} onSplitting={onSplitting} />
  ),
  action: ({ ctx }) => <ActionOutcome ctx={ctx} />,
  plan: ({ ctx }) => <PlanSection ctx={ctx} />,
  decision: ({ ctx }) => <DecisionPanel ctx={ctx} />,
  deploys: ({ ctx }) => <DeploysPanel ctx={ctx} />,
  environments: ({ ctx }) => <EnvironmentsPanel ctx={ctx} />,
  tests: ({ ctx }) => <TestsPanel ctx={ctx} />,
  'human-steps': ({ ctx, actions, section, onAddStep, onCompleteStep, onDismissStep }) => (
    <HumanSteps
      glob={ctx.glob}
      {...(actions.viewer === undefined ? {} : { viewer: actions.viewer })}
      canAdd
      repo={ctx.board.repo}
      baseBranch={ctx.board.baseBranch}
      startOpen={section === 'human-steps'}
      collapsed={actions.human}
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
  assessment: ({ ctx }) => <DecisionAssessmentPanel ctx={ctx} />,
  findings: ({ ctx }) => <FindingsPanel ctx={ctx} />,
};

/** Sections that render after another one's anchor without an anchor of their own (the Activity log and the edit fields, under the actions). */
export const AFTER_SECTION: Partial<Record<GlobSection, SectionView>> = {
  actions: ({ ctx, actions, nowState, edits, onReload }) => (
    <>
      <ActivityLog ctx={ctx} state={nowState} actions={actions} />
      <EditFieldsSection
        ctx={ctx}
        decision={actions.human}
        edits={edits}
        run={actions.run}
        onReload={onReload}
      />
    </>
  ),
};
