import type { Arm, ActionScript, ScriptCheck, Category, InferenceSource, SlopType, WorkInference, WorkActor, WorkKind, Action, ArtifactSummary, AwaitedDependency, CompactHumanStep, DomainError, Glob, Handover, Holding, HumanStep, Relation, RelationFacts, RelationSuggestion, RelationsView, Role, SizeCheck, StoredHumanStep } from '@slop/core';
import { HUMAN_CATEGORIES, SLOP_TYPES, defaultFix, defaultWorkKind, inferenceReasonOf, isHumanCategory, actorOf, categoryFor, storedCategory, blockProgress, storedBlockProgress, checksExplanation, compactStep, fixOf, modeOf, workKindOf, humanSteps, openRolloutSteps, actionState, preparationOf, isActive, isExplicit, listWithSteps, machine, unresolved } from '@slop/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** The globs a person, an agent or (an old row) a split said this one starts after (the old `after` list). */
const explicitNeeds = (relations: readonly Relation[]): string[] =>
  relations.filter((r) => r.gate === 'start' && isExplicit(r) && isActive(r)).map((r) => r.to);

/**
 * Who works on a glob and how, with the fix flag and work kind: derived or read through the old category for a record from
 * before they were stored. `category` and `type` stay on the view for one release.
 */
export const kindView = (glob: Glob) => ({
  actor: actorOf(glob),
  mode: modeOf(glob),
  fix: fixOf(glob),
  fixSource: glob.fixSource ?? 'inferred',
  workKind: workKindOf(glob),
  workKindSource: glob.workKindSource ?? 'inferred',
  // An action only: where a prepared one stands (open, waiting, preparing, preparation_failed, ready, recording, closed) and how it is prepared.
  ...(actionState(glob) === null ? {} : { actionState: actionState(glob), preparation: preparationOf(glob) }),
});

/** What a caller says about who works on a glob and how: the new fields, and the old `category` and `type` as aliases. */
export interface KindInput {
  readonly actor?: WorkActor | undefined;
  readonly mode?: SlopType | 'decision' | 'action' | undefined;
  readonly fix?: boolean | undefined;
  readonly workKind?: WorkKind | undefined;
  readonly category?: Category | undefined;
  readonly type?: SlopType | null | undefined;
}

export type KindResolved =
  | { readonly ok: true; readonly type: SlopType | null | undefined; readonly category: Category | undefined; readonly fix: boolean | undefined; readonly workKind: WorkKind | undefined }
  | { readonly ok: false; readonly message: string };

const isMachineMode = (m: string): m is SlopType => (SLOP_TYPES as readonly string[]).includes(m);
const isHumanMode = (m: string): m is 'decision' | 'action' => (HUMAN_CATEGORIES as readonly string[]).includes(m);

/**
 * Folds `actor` and `mode` into the old `type` and `category` the service takes, refusing a mix that means nothing (a machine
 * action, a human sub, a mode that contradicts `type` or `category`). Nobody chooses a category any more: without one, `fix` and
 * `workKind` give it (the stored legacy field); with neither, it stays unset and the caller's default or intake decides.
 * `create` refuses a decision (slop makes those); an update cannot move a glob between actors.
 */
export const resolveKind = (input: KindInput, create: boolean): KindResolved => {
  const bad = (message: string): KindResolved => ({ ok: false, message });
  let type = input.type;
  let category = input.category;
  let mode = input.mode;
  if (input.actor === 'human' && mode === undefined && create) mode = 'action';
  if (mode !== undefined) {
    if (input.actor === 'machine' && isHumanMode(mode)) return bad(`A machine glob has a type (sub, same or super), not ${mode}`);
    if (input.actor === 'human' && isMachineMode(mode)) return bad(`A human glob is a decision or an action, not a ${mode}`);
    if (isMachineMode(mode)) {
      if (type !== undefined && type !== mode) return bad(`mode ${mode} contradicts type ${String(type)}`);
      type = mode;
    } else {
      if (!create) return bad('A glob cannot change between machine and human work');
      if (mode === 'decision') return bad('Decision globs are created by slop from learnings, never here');
      if (category !== undefined && category !== mode) return bad(`mode ${mode} contradicts category ${category}`);
      if (type !== undefined && type !== null) return bad(`A ${mode} has no type`);
      category = mode;
    }
  } else if (input.actor === 'human' && !create) {
    return bad('A glob cannot change between machine and human work');
  }
  if (create && category === undefined && (input.fix !== undefined || input.workKind !== undefined) && type !== null) {
    category = categoryFor(input.fix ?? false);
  }
  if (input.actor === 'machine' && category !== undefined && isHumanCategory(category)) return bad(`A machine glob cannot be a ${category}`);
  // Human work is never a fix and has no work kind to choose.
  if (category !== undefined && isHumanCategory(category)) return { ok: true, type, category, fix: undefined, workKind: undefined };
  return { ok: true, type, category, fix: input.fix, workKind: input.workKind };
};

/** The kind fields a create passes to the service. */
export interface CreateKindFields {
  readonly category: Category;
  readonly fix?: boolean;
  readonly fixSource?: InferenceSource;
  readonly workKind?: WorkKind;
  readonly workKindSource?: InferenceSource;
  readonly inferenceReason?: string | null;
}

/**
 * The stored category, fix flag and work kind for a create that skipped intake's proposal (a titled create, the CLI): what the
 * caller said is a person's choice (an old `category` alias says both); the rest is inferred from the title and plan with `infer`
 * (absent or a super: not a fix, maintenance). A fix is never a super. An asked `feature` means R&D and is stored as a task.
 */
export const createKindFields = async (
  input: { readonly type?: SlopType | null | undefined; readonly category?: Category | undefined; readonly fix?: boolean | undefined; readonly workKind?: WorkKind | undefined },
  infer: (() => Promise<WorkInference>) | undefined,
): Promise<CreateKindFields> => {
  const { category } = input;
  if (category !== undefined && isHumanCategory(category)) return { category };
  const fix = input.fix ?? (category === undefined ? undefined : defaultFix(category));
  const workKind = input.workKind ?? (category === undefined ? undefined : defaultWorkKind(category));
  const found = (fix === undefined || workKind === undefined) && infer !== undefined ? await infer() : null;
  const chosenFix = fix ?? (input.type === 'super' ? false : (found?.fix ?? false));
  const chosenKind = workKind ?? found?.workKind ?? 'maintenance';
  return {
    // An asked `feature` implied R&D above; it is stored as a task.
    category: category === undefined ? categoryFor(chosenFix) : storedCategory(category),
    fix: chosenFix,
    fixSource: fix === undefined ? 'inferred' : 'person',
    workKind: chosenKind,
    workKindSource: workKind === undefined ? 'inferred' : 'person',
    ...(found === null ? {} : { inferenceReason: inferenceReasonOf(found) }),
  };
};

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
  ...kindView(glob),
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

/** The Arm system stage on a view: the environment (or base branch) whose rollout step is next, and that step's title. Absent when no step is open. */
export const armField = (arm: Arm | null) => (arm === null ? {} : { arm });

/** A glob read through the service: its view with the actions open to the caller and what it waits for. */
export const globViewOf = (v: { glob: Glob; allowedActions: readonly Action[]; artifacts: readonly ArtifactSummary[]; relations: readonly Relation[]; waitingFor: readonly AwaitedDependency[]; waitedOnBy: readonly string[]; holding: readonly Holding[]; relationGroups: RelationsView; sizeCheck?: SizeCheck | null; humanSteps?: readonly HumanStep[]; rolloutSteps?: number; arm?: Arm | null; handover?: Handover | null; dismissedKeys?: readonly string[]; script?: ActionScript | null; suggestions?: readonly RelationSuggestion[] }) =>
  ({
    ...globView(v.glob, v.allowedActions, v.artifacts, v, v.humanSteps ?? null, v.relations, v.holding),
    waitingFor: v.waitingFor,
    waitedOnBy: v.waitedOnBy,
    ...(v.rolloutSteps === undefined ? {} : { rolloutSteps: v.rolloutSteps }),
    ...armField(v.arm ?? null),
    // The script an open action runs and whether the base branch has it (null `onBase`: not checked); null for any other glob.
    script: v.script ?? null,
    // Open card questions (a failed step: link a glob?), only when there are some.
    ...(v.suggestions === undefined || v.suggestions.length === 0 ? {} : { suggestions: v.suggestions }),
    // The glob's relations in groups: what holds it back (the same as `holding`), what it holds back, and what no longer holds.
    relations: v.relationGroups,
    // Why a person is needed and what to do first (null when nothing is wrong); the card and `sstor --glob` show it.
    handover: v.handover ?? null,
    // The status messages the viewer dismissed (per person): the card and the Now panel collapse them.
    dismissedKeys: v.dismissedKeys ?? [],
    // The size check: the flag (advice only), why, the estimate's evidence and the proposed workstreams (get_glob carries it to routines).
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
  /** The board's open work steps for this glob (the list reads them for the whole board at once). */
  stored: readonly StoredHumanStep[] = [],
  /** An open action's script check, where the list read it. */
  check?: ScriptCheck,
) => ({
  ...globView(
    glob,
    machine.allowedActions(
      glob,
      { email, role },
      {
        recordSha: machine.recordShaOf(artifacts ?? []),
        ...(check === undefined ? {} : { script: check.script, baseBranch: check.baseBranch }),
        // Without the artifacts loaded the reviews are unknown, so no Retry review is guessed.
        ...(artifacts === null ? {} : { reviews: machine.reviewsOf(artifacts) }),
        ...(relations === undefined ? {} : { relations }),
        // Merge and continue instead of Merge for a same with open rollout steps; Pick up on its merged glob.
        rolloutSteps: openRolloutSteps(stored),
        // Sign off anyway is offered only once no step holds the sign-off back.
        rollout: storedBlockProgress(stored, 'sign_off'),
      },
    ),
    artifacts,
    null,
    humanSteps(
      glob,
      { recordAtHead: machine.recordAtHead(glob, { recordSha: machine.recordShaOf(artifacts ?? []) }), rolloutSteps: openRolloutSteps(stored) },
      stored,
    ).map(compactStep),
    relations?.relations ?? null,
    holding,
  ),
  // The count the web reads for "Merge and continue" (it must not re-derive it from the steps).
  rolloutSteps: openRolloutSteps(stored),
  ...(check === undefined ? {} : { script: check.script }),
});

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

/** A workstream's plan is the whole plan again plus its share; an agent that reads a glob needs its name and shape, not 10 KB of repeats. */
const PART_SUMMARY_CHARS = 200;

/**
 * The glob view with the size check's proposed workstreams trimmed for MCP reads: each keeps its name, goal, files and needs, and
 * its plan share becomes a short summary with its length. `get_context`'s `size` carries the workstreams in full.
 */
export const compactSizeProposal = <V extends { sizeCheck?: SizeCheck | null }>(view: V): V => {
  const proposal = view.sizeCheck?.proposal;
  if (proposal == null || view.sizeCheck == null) return view;
  const workstreams = proposal.workstreams.map(({ plan, ...rest }) => ({ ...rest, planSummary: plan.replace(/\s+/g, ' ').slice(0, PART_SUMMARY_CHARS), planChars: plan.length }));
  return { ...view, sizeCheck: { ...view.sizeCheck, proposal: { ...proposal, workstreams } } };
};

/** A suggestion's text as an agent's read carries it: the id to accept or dismiss, the kind and a clipped line. */
const SUGGESTION_TEXT_CHARS = 160;

/**
 * The glob view with the card suggestions as a short list for MCP reads (`id`, `kind`, `mentioned`, a clipped `text`); the REST
 * read carries them whole. The relations stay as `get_glob` always carried them: grouped, with `external` set where a relation
 * points at another board (redacted by core for a viewer who is not a member of it).
 */
export const compactSuggestions = <V extends { suggestions?: readonly RelationSuggestion[] }>(view: V): V =>
  view.suggestions === undefined
    ? view
    : {
        ...view,
        suggestions: view.suggestions.map(({ id, kind, mentioned, gate, stepId, text }) => ({
          id,
          kind,
          mentioned,
          ...(gate === undefined ? {} : { gate }),
          ...(stepId === undefined ? {} : { stepId }),
          text: text.length <= SUGGESTION_TEXT_CHARS ? text : `${text.slice(0, SUGGESTION_TEXT_CHARS)}…`,
        })),
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
