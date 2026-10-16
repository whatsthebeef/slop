import type { FileState } from '../../domain/attachment-file.js';
import type { AtfSpecList } from '../../domain/test-plan.js';
import type { DecisionView } from '../../domain/decisions.js';
import type { ScopedDecision } from '../../domain/decision-glob.js';
import type { Payload } from '../../domain/payload.js';
import type { GlobAttributes } from '../../domain/attributes.js';
import type { Handover } from '../../domain/handover.js';
import type { GroupContext } from '../../domain/group-view.js';
import type { HumanStep } from '../../domain/human-steps.js';
import type { SearchHit } from '../../domain/search.js';
import type { OpenQuestion } from '../../domain/questions.js';
import type { ActionState } from '../../domain/action-glob.js';
import type { Glob, Mode, WorkActor, WorkKind } from '../../domain/types.js';
import type { ArtifactListing } from './artifact-listing.js';
import type { GlobHotspot } from './hotspot-section.js';
import type { RelationLearningContext } from './relation-learning-section.js';
import type { InboxContextItem } from './inbox-section.js';
import type { InvestigationSummary } from './investigation-section.js';
import type { SizeContext } from './size-section.js';

export interface GlobContext {
  readonly glob: Pick<Glob, 'id' | 'title' | 'type' | 'category' | 'group' | 'environment' | 'status'> & {
    readonly actor: WorkActor;
    readonly mode: Mode;
    readonly fix: boolean;
    readonly workKind: WorkKind;
    /** An action only: where it stands (see `actionState`); absent on any other glob. */
    readonly actionState?: ActionState;
  };
  readonly board: { readonly id: number; readonly repo: string | null; readonly baseBranch: string };
  /** plan.md: the latest version. */
  readonly plan: { readonly version: number; readonly content: string } | null;
  /**
   * The latest test plan (full text): the matrix of specs that prove the change and the `atf-specs` block the pipeline runs
   * after the merge. `atfSpecs` is the parsed block (null when there is none); `validation` says what is wrong with it. Null
   * when none is saved yet.
   */
  readonly testPlan: {
    readonly version: number;
    readonly content: string;
    readonly atfSpecs: AtfSpecList | null;
    readonly validation: string | null;
  } | null;
  /** What the glob is about: plan.md for work, the proposal text for a decision. The same as `plan`, which older agent sets read. */
  readonly payload: Payload | null;
  /** A decision's scope, source and outcome; absent on work globs. */
  readonly attributes?: GlobAttributes;
  /**
   * The accepted decisions that govern this glob by scope, broadest first (live: one accepted after the glob was created
   * still reaches it). Empty when none, and for a decision glob.
   */
  readonly scopedDecisions: readonly ScopedDecision[];
  /** The implementation record (every glob type, one format): the latest version, in full; null before the first is pushed. */
  readonly implementationRecord: { readonly version: number; readonly commitSha: string | null; readonly content: string } | null;
  /** Attachments in full: Clarifications and Assumptions always (they carry intent), others when asked for with `include`. */
  readonly attachments: readonly { readonly label: string; readonly content: string; readonly link: string | null }[];
  /**
   * File attachments (images, PDFs, documents) with their state. A `stored` one can be downloaded (the MCP layer adds a
   * fresh `downloadUrl`); `pending` ones are still being uploaded; a `missing` one carries `note`. Don't block on missing files: record the gap.
   */
  readonly files: readonly {
    readonly label: string;
    readonly fileName: string;
    readonly contentType: string;
    readonly size: number | null;
    readonly state: FileState;
    readonly note?: string;
  }[];
  /** Every other artifact, not in full: fetch one with `get_artifact` or `include` on `get_context`. */
  readonly available: readonly ArtifactListing[];
  /**
   * What the board already knows about this glob's title and plan (current mode, top 5, cited, the glob's own
   * items left out). Absent when no search is configured.
   */
  readonly related?: readonly SearchHit[];
  /**
   * The decisions taken on this glob (from its implementation record's Decisions, plan.md, Clarifications and
   * Assumptions), current ones first, each with its source link; a superseded one says what replaced it and when.
   */
  readonly decisions: readonly DecisionView[];
  /**
   * Inbox items attached to this glob (pasted meeting notes, threads, documents), with their text up to
   * `INBOX_CONTEXT_CHARS` (`truncated` beyond it; `search_text` finds the rest).
   */
  readonly inbox: readonly InboxContextItem[];
  /**
   * The glob's latest investigation, when it has one: what the orchestrator needs to decide reuse vs refresh without fetching
   * it (the plan hash and base commit it was made against, and the files it expects to change). Fetch the text with
   * `get_artifact(id, 'investigation')`.
   */
  readonly investigation?: InvestigationSummary;
  /**
   * Present while an investigate-only run is still working on the glob: the orchestrator waits for it (polling `get_glob`,
   * every 2 minutes at most, up to 20) and reuses its result, instead of investigating again.
   */
  readonly investigationRunning?: { readonly runId: string; readonly since: string; readonly sessionUrl: string | null };
  /** Why a person is needed on this glob and what to do first (a hand-over brief); null when nothing is wrong. */
  readonly handover: Handover | null;
  /** Which source wins when sources disagree (the spec's order of authority). */
  readonly authority: string;
  /** Everything only a person can do on the glob (the machine's steps and stored work steps), most pressing first. */
  readonly humanSteps: readonly HumanStep[];
  /**
   * The board's conflict hotspots among the glob's files (the paths its investigation or plan.md names, and files it conflicted on),
   * hottest first, with their counts. Empty when none; absent when hotspots are not configured.
   */
  readonly hotspots?: readonly GlobHotspot[];
  /**
   * How reliable relations from each source have been on this board (agent first, then mention and inferred): precision over the
   * window, how many outcomes it rests on and whether slop now makes that source's relations weak. Add a relation only for a
   * concrete dependency. Absent when relation learning is not configured.
   */
  readonly relationLearning?: readonly RelationLearningContext[];
  /**
   * Present when the glob's group has other open or recently merged globs, or open decisions: what the neighbours do (ID, title,
   * status, one line of plan) and the decisions still open, so a run needn't read their plans. Absent otherwise.
   */
  readonly group?: GroupContext;
  /**
   * The glob's questions: `open` ones still wait for a person (a `start` or `merge` one holds the glob: don't call
   * `answer_question`, that is a person's call), `answered` ones (answered or dismissed) are also in the Clarifications attachment above.
   */
  readonly questions: { readonly open: readonly OpenQuestion[]; readonly answered: readonly OpenQuestion[] };
  /** Present when intake judged the glob: the oversized flag (advice only), its reasons and the proposed workstreams. */
  readonly size?: SizeContext;
  readonly fetch: string;
}
