import type { Action, ArtifactSummary, AwaitedDependency, CompactHumanStep, DomainError, Glob, Handover, Holding, HumanStep, Relation, RelationFacts, RelationsView, Role, SizeCheck, StoredHumanStep } from '@slop/core';
import { blockProgress, checksExplanation, compactStep, humanSteps, isActive, isExplicit, listWithSteps, machine, unresolved } from '@slop/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** The globs a person, an agent or a split said this one starts after (the old `after` list). */
const explicitNeeds = (relations: readonly Relation[]): string[] =>
  relations.filter((r) => r.gate === 'start' && isExplicit(r) && isActive(r)).map((r) => r.to);

/**
 * The glob as clients see it: the stored document plus derived fields, and its artifact
 * summaries where the caller read them (they live in the artifacts table, not on the glob).
 */
export const globView = (
  glob: Glob,
  allowedActions: readonly Action[] | null = null,
  artifacts: readonly ArtifactSummary[] | null = null,
  /** What the glob waits for and what waits for it, where the caller read them (one glob's view, not the list). */
  waits: { readonly waitingFor: readonly AwaitedDependency[]; readonly waitedOnBy: readonly string[] } | null = null,
  /** What a person must do on the glob (the compact form on lists, the full steps on a single read); absent where not computed. */
  steps: readonly CompactHumanStep[] | null = null,
  /** The glob's own relations, where the caller read them: what a person set shows as `after`. */
  relations: readonly Relation[] | null = null,
  /** The glob's unmet relations (any gate) with the title of what each points at, where the caller computed them (the list and the single read). */
  holding: readonly Holding[] | null = null,
) => ({
  ...glob,
  // The lists the document kept before relations (and the predicted overlaps beside them) are internal data: never shown. `after` below comes from the relations.
  after: undefined,
  impliedAfter: undefined,
  // What a person (or a split) said the glob starts after, as the stored document used to hold it.
  ...(relations === null || explicitNeeds(relations).length === 0 ? {} : { after: explicitNeeds(relations) }),
  // A merged glob whose rollout still holds back its sign-off stays in Doing.
  list: listWithSteps(glob, steps === null ? null : blockProgress(steps, 'sign_off')),
  branch: glob.id,
  currentRun: machine.currentRun(glob),
  /** Why the head's checks failed, and whether the base branch is red the same way (then it isn't this glob's change). */
  failedChecks: checksExplanation(glob),
  ...(allowedActions === null ? {} : { allowedActions }),
  ...(artifacts === null ? {} : { artifacts: artifacts.map(artifactView) }),
  ...(waits === null ? {} : { waitingFor: waits.waitingFor, waitedOnBy: waits.waitedOnBy }),
  ...(steps === null ? {} : { humanSteps: steps }),
  // What holds the glob back right now: its unmet relations (a start, merge or sign-off gate), whose-move and the card read them.
  ...(holding === null ? {} : { holding }),
});

/** A glob read through the service: its view with the actions open to the caller and what it waits for. */
export const globViewOf = (v: { glob: Glob; allowedActions: readonly Action[]; artifacts: readonly ArtifactSummary[]; relations: readonly Relation[]; waitingFor: readonly AwaitedDependency[]; waitedOnBy: readonly string[]; holding: readonly Holding[]; relationGroups: RelationsView; sizeCheck?: SizeCheck | null; humanSteps?: readonly HumanStep[]; handover?: Handover | null; dismissedKeys?: readonly string[] }) =>
  ({
    ...globView(v.glob, v.allowedActions, v.artifacts, v, v.humanSteps ?? null, v.relations, v.holding),
    waitingFor: v.waitingFor,
    waitedOnBy: v.waitedOnBy,
    // The glob's relations in groups: what holds it back (the same as `holding`), what it holds back, and what no longer holds.
    relations: v.relationGroups,
    // Why a person is needed and what to do first (null when nothing is wrong); the card and `sstor --glob` show it.
    handover: v.handover ?? null,
    // The status messages the viewer dismissed (per person): the card and the Now panel collapse them.
    dismissedKeys: v.dismissedKeys ?? [],
    // The size check: the flag, why, the estimate's evidence and the proposed split (get_glob carries it to routines).
    ...(v.sizeCheck == null ? {} : { sizeCheck: v.sizeCheck, oversized: v.glob.status === 'planning' && unresolved(v.sizeCheck) }),
  });

/** An artifact summary on a glob view (the glob ID is implied). */
const artifactView = ({ kind, label, version, versions, commitSha, createdAt, by, actor, review, file }: ArtifactSummary) => ({
  kind,
  label,
  version,
  versions,
  commitSha,
  createdAt,
  by,
  actor,
  ...(review === undefined ? {} : { review }),
  ...(file === undefined ? {} : { file }),
});

export const globViewFor = (
  glob: Glob,
  email: string,
  role: Role,
  artifacts: readonly ArtifactSummary[] | null = null,
  /** The glob's relations and what they point at, so a held glob's actions don't rest on its `waiting` mark. */
  relations?: RelationFacts,
  /** The glob's unmet relations (see `holdingOf`), computed by the service for the whole list. */
  holding: readonly Holding[] = [],
  /** Held in Planning for an unanswered oversized flag: nothing unmerged is awaited, yet Start now applies. */
  sizeHeld = false,
  /** The board's open work steps for this glob (the list reads them for the whole board at once). */
  stored: readonly StoredHumanStep[] = [],
) =>
  globView(
    glob,
    machine.allowedActions(
      glob,
      { email, role },
      { recordSha: machine.recordShaOf(artifacts ?? []), ...(relations === undefined ? {} : { relations }), sizeHeld },
    ),
    artifacts,
    null,
    humanSteps(glob, { recordAtHead: machine.recordAtHead(glob, { recordSha: machine.recordShaOf(artifacts ?? []) }) }, stored).map(compactStep),
    relations?.relations ?? null,
    holding,
  );

export const statusOf = (error: DomainError): ContentfulStatusCode => {
  switch (error.code) {
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'version_conflict':
    case 'invalid_transition':
    case 'run_active':
      return 409;
    case 'invalid_combination':
    case 'invalid_input':
      return 422;
    case 'llm_unavailable':
      return 503;
  }
};

export const errorBody = (error: DomainError) =>
  error.code === 'version_conflict' && 'current' in error ? { ...error, current: globView(error.current) } : error;

const SIGNED_OFF_VISIBLE_MS = 14 * 86_400_000;

/** Signed-off globs drop off the board after two weeks (computed on display). */
export const onBoard = (glob: Glob, now: number): boolean =>
  glob.status !== 'signed_off' ||
  glob.signedOffAt === null ||
  now - Date.parse(glob.signedOffAt) < SIGNED_OFF_VISIBLE_MS;
