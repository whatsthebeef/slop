import type { Action, ArtifactSummary, AwaitedDependency, BlockingChain, DependencyState, CompactHumanStep, DomainError, Glob, Handover, HumanStep, Role, SizeCheck, StoredHumanStep } from '@slop/core';
import { blockProgress, checksExplanation, compactStep, edgesOf, humanSteps, listWithSteps, machine, unresolved } from '@slop/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

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
  /** The chain of unmerged prerequisites ahead of the glob; nothing is added while it is empty. */
  chain: BlockingChain | null = null,
  /** What a person must do on the glob (the compact form on lists, the full steps on a single read); absent where not computed. */
  steps: readonly CompactHumanStep[] | null = null,
) => ({
  ...glob,
  // Every dependency edge with its kind (needs block the start, overlaps only order merges), source and evidence.
  ...(edgesOf(glob).length === 0 ? {} : { edges: edgesOf(glob) }),
  // A merged glob whose rollout still holds back its sign-off stays in Doing.
  list: listWithSteps(glob, steps === null ? null : blockProgress(steps, 'sign_off')),
  branch: glob.id,
  currentRun: machine.currentRun(glob),
  /** Why the head's checks failed, and whether the base branch is red the same way (then it isn't this glob's change). */
  failedChecks: checksExplanation(glob),
  ...(allowedActions === null ? {} : { allowedActions }),
  ...(artifacts === null ? {} : { artifacts: artifacts.map(artifactView) }),
  ...(waits === null ? {} : { waitingFor: waits.waitingFor, waitedOnBy: waits.waitedOnBy }),
  ...(chain === null || chain.blockedBy.length === 0 ? {} : { blockedBy: chain.blockedBy, nextStartable: chain.nextStartable }),
  ...(steps === null ? {} : { humanSteps: steps }),
});

/** A glob read through the service: its view with the actions open to the caller and what it waits for. */
export const globViewOf = (v: { glob: Glob; allowedActions: readonly Action[]; artifacts: readonly ArtifactSummary[]; waitingFor: readonly AwaitedDependency[]; waitedOnBy: readonly string[]; chain: BlockingChain; sizeCheck?: SizeCheck | null; humanSteps?: readonly HumanStep[]; handover?: Handover | null; dismissedKeys?: readonly string[] }) =>
  ({
    ...globView(v.glob, v.allowedActions, v.artifacts, v, v.chain, v.humanSteps ?? null),
    waitingFor: v.waitingFor,
    waitedOnBy: v.waitedOnBy,
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
  /** The state of the globs this one waits for, so a held glob's actions don't rest on its `waiting` mark. */
  dependencies?: ReadonlyMap<string, DependencyState>,
  chain: BlockingChain | null = null,
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
      {
        recordSha: machine.recordShaOf(artifacts ?? []),
        // Without the artifacts loaded the reviews are unknown, so no Retry review is guessed.
        ...(artifacts === null ? {} : { reviews: machine.reviewsOf(artifacts) }),
        ...(dependencies === undefined ? {} : { dependencies }), sizeHeld },
    ),
    artifacts,
    null,
    chain,
    humanSteps(glob, { recordAtHead: machine.recordAtHead(glob, { recordSha: machine.recordShaOf(artifacts ?? []) }) }, stored).map(compactStep),
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

/** A part's plan is the whole plan again plus its share; an agent that reads a glob needs the part's title and shape, not 10 KB of repeats. */
const PART_SUMMARY_CHARS = 200;

/**
 * The glob view with the size check's proposed split trimmed for MCP reads: each part keeps its title and needs, and its plan
 * becomes a short summary with its length. `get_glob` with `include: ['size_proposal']` returns the plans in full (split_glob's input).
 */
export const compactSizeProposal = <V extends { sizeCheck?: SizeCheck | null }>(view: V): V => {
  const proposal = view.sizeCheck?.proposal;
  if (proposal == null || view.sizeCheck == null) return view;
  const parts = proposal.parts.map(({ plan, ...rest }) => ({ ...rest, planSummary: plan.replace(/\s+/g, ' ').slice(0, PART_SUMMARY_CHARS), planChars: plan.length }));
  return { ...view, sizeCheck: { ...view.sizeCheck, proposal: { ...proposal, parts } } };
};

const KB_TEXT_CHARS = 400;
const clip = (text: string): string => (text.length <= KB_TEXT_CHARS ? text : `${text.slice(0, KB_TEXT_CHARS)}…`);

/**
 * A KB item as `list_kb_items` lists it by default: what an admin needs to pick one to decide on. Long text is clipped with its
 * full length alongside, and the preview and the extra evidence are left out; `detail: 'full'` returns an item whole.
 */
export const compactKbItem = (item: Record<string, unknown>) => {
  const { extraEvidence, draft, document, evidence, ...rest } = item;
  delete rest.preview;
  const draftOf = draft as { section: string | null; content: string } | null | undefined;
  const documentOf = document as { content: string } | null | undefined;
  return {
    ...rest,
    evidence: typeof evidence === 'string' ? clip(evidence) : evidence,
    ...(typeof evidence === 'string' && evidence.length > KB_TEXT_CHARS ? { evidenceChars: evidence.length } : {}),
    extraEvidenceCount: Array.isArray(extraEvidence) ? extraEvidence.length : 0,
    draft: draftOf == null ? null : { section: draftOf.section, content: clip(draftOf.content), contentChars: draftOf.content.length },
    ...(documentOf == null ? { document: null } : { document: { ...documentOf, content: clip(documentOf.content), contentChars: documentOf.content.length } }),
  };
};
