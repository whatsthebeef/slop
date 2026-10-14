import { missingFileNote } from '../domain/attachment-file.js';
import type { AttachmentFile, FileState } from '../domain/attachment-file.js';
import { decisionViews } from '../domain/decisions.js';
import type { DecisionView } from '../domain/decisions.js';
import { parseInvestigation, validationNote } from '../domain/investigation.js';
import { err, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { INBOX_CONTEXT_CHARS, inboxLink, inboxTitle } from '../domain/inbox.js';
import { ARTIFACT_ROLE } from '../domain/knowledge.js';
import type { Artifact, ArtifactKind, IndependentReviewMeta, Provenance, ReviewStats } from '../domain/knowledge.js';
import { applicableDecisions, isArchivedDecision, scopedDecision } from '../domain/decision-glob.js';
import type { ScopedDecision } from '../domain/decision-glob.js';
import { payloadOf } from '../domain/payload.js';
import type { Payload } from '../domain/payload.js';
import type { GlobAttributes } from '../domain/attributes.js';
import { recheckOverlapsEffect } from '../domain/events.js';
import { handoverBrief, openFindings, resumePhase } from '../domain/handover.js';
import type { Handover } from '../domain/handover.js';
import { groupContext, inGroup } from '../domain/group-view.js';
import type { GroupContext } from '../domain/group-view.js';
import { humanSteps } from '../domain/human-steps.js';
import type { HumanStep } from '../domain/human-steps.js';
import { currentRun, investigationRunning } from '../domain/machine.js';
import type { Hotspot } from '../domain/hotspots.js';
import type { SearchHit } from '../domain/search.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Notifier, Store, Tx } from '../ports.js';
import { memberOf } from './access.js';
import type { InvestigationReactor } from './investigation-service.js';
import type { SizeAssessor } from './size-check-service.js';
import type { SizeCheck } from '../domain/size-check.js';
import type { SizeForecast } from '../domain/size-forecast.js';

/** The hand-over brief of a glob as it stands, from its newest local review and uploaded artifacts. */
export const handoverOf = async (tx: Tx, clock: Clock, glob: Glob): Promise<Handover | null> => {
  const findings = openFindings(await tx.listFindings(glob.id), await tx.listReviewSources(glob.id));
  const artifacts = await tx.listArtifactSummaries(glob.boardId, [glob.id]);
  return handoverBrief(glob, { now: clock.now(), findings, resumePhase: resumePhase(artifacts, glob.pr?.headSha ?? null) });
};

/** The accepted decisions that govern a work glob, each with its one-line statement read from its plan.md. */
export const governingDecisions = async (tx: Tx, glob: Glob): Promise<ScopedDecision[]> => {
  const decisions = applicableDecisions(await tx.listGlobs(glob.boardId, { include: 'decisions' }), glob);
  const scoped: ScopedDecision[] = [];
  for (const decision of decisions) {
    const entry = scopedDecision(decision, (await tx.listArtifacts(decision.id, 'plan'))[0]?.content);
    if (entry !== null) scoped.push(entry);
  }
  return scoped;
};

/** A hotspot as `get_context` shows it: the path with its counts inside the window. */
export type GlobHotspot = Pick<Hotspot, 'path' | 'conflicts' | 'real' | 'lastConflictAt'> & {
  readonly globs: number;
  readonly windowDays: number;
};

/** Whether `path` appears in `text` as a whole path (not inside a longer name such as `data.ts` for `a.ts`). */
const namesPath = (text: string, path: string): boolean => {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const before = text[at - 1];
    const after = text[at + path.length];
    if ((before === undefined || !/[\w./-]/.test(before)) && (after === undefined || !/[\w-]/.test(after) && !/\.\w/.test(text.slice(at + path.length, at + path.length + 2)))) return true;
  }
  return false;
};

/** The board's hotspots that are among the files a glob plans to change, or that it conflicted on itself. */
const hotspotsOfGlob = (
  view: { readonly windowDays: number; readonly hotspots: readonly Hotspot[] },
  globId: string,
  planned: readonly string[],
  plan: string,
): GlobHotspot[] =>
  view.hotspots
    .filter((h) => planned.includes(h.path) || namesPath(plan, h.path) || h.globs.includes(globId))
    .map((h) => ({
      path: h.path,
      conflicts: h.conflicts,
      globs: h.globs.length,
      real: h.real,
      lastConflictAt: h.lastConflictAt,
      windowDays: view.windowDays,
    }));

export interface GlobContext {
  readonly glob: Pick<Glob, 'id' | 'title' | 'type' | 'category' | 'group' | 'environment' | 'status'>;
  readonly board: { readonly id: number; readonly repo: string | null; readonly baseBranch: string };
  /** plan.md: the latest version. */
  readonly plan: { readonly version: number; readonly content: string } | null;
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
   * Present when the glob's group has other open or recently merged globs, or open decisions: what the neighbours do (ID, title,
   * status, one line of plan) and the decisions still open, so a run needn't read their plans. Absent otherwise.
   */
  readonly group?: GroupContext;
  /** Present when intake judged the glob: the oversized flag (advice only), its reasons and the proposed workstreams. */
  readonly size?: SizeContext;
  readonly fetch: string;
}

export interface SizeContext {
  readonly oversized: boolean;
  readonly reasons: readonly string[];
  readonly evidence: readonly string[];
  /** `split` once the glob's scope was cut into independent globs; null otherwise. */
  readonly decision: SizeCheck['decision'];
  /** Workstreams the run can work in parallel inside this glob's one PR (name, goal, files, plan share, `needs` as earlier indexes). */
  readonly proposal: SizeCheck['proposal'];
  /** Present once the code forecast was made: predicted files and parts; confirm or correct. */
  readonly forecast?: SizeForecastContext;
}

/** The forecast as the investigator receives it: its starting point, to confirm or correct in the investigation. */
export interface SizeForecastContext {
  readonly note: string;
  readonly files: readonly string[];
  readonly modules: readonly string[];
  readonly parts: SizeForecast['parts'];
  readonly expectedLines: SizeForecast['lines'];
  readonly riskTier: SizeForecast['riskTier'];
  readonly riskAreas: readonly string[];
  readonly migration: boolean;
  readonly publicApi: boolean;
  readonly confidence: SizeForecast['confidence'];
  readonly history: string | null;
}

export const FORECAST_NOTE = 'predicted files and parts; confirm or correct';

const sizeContext = (check: SizeCheck): SizeContext => ({
  oversized: check.flagged,
  reasons: check.reasons,
  evidence: check.evidence,
  decision: check.decision,
  proposal: check.proposal,
  ...(check.estimate.forecast === undefined ? {} : { forecast: forecastContext(check.estimate.forecast) }),
});

const forecastContext = (f: SizeForecast): SizeForecastContext => ({
  note: FORECAST_NOTE,
  files: f.files.paths,
  modules: f.modules,
  parts: f.parts,
  expectedLines: f.lines,
  riskTier: f.riskTier,
  riskAreas: f.riskAreas,
  migration: f.migration,
  publicApi: f.publicApi,
  confidence: f.confidence,
  history: f.reference?.summary ?? null,
});

export interface InvestigationSummary {
  readonly version: number;
  readonly createdAt: string;
  /** The run that made it (null for a person's push). */
  readonly runId: string | null;
  /** Set when the block did not validate: the text is kept but there is nothing to compare, so refresh. */
  readonly validation: string | null;
  readonly planHash: string | null;
  readonly baseCommit: string | null;
  /** Paths the investigation expects to create, modify or delete (the relevant files to check the base for changes). */
  readonly files: readonly string[];
  readonly riskTier: string | null;
  readonly confidence: string | null;
  readonly needsHuman: boolean | null;
}

const investigationSummary = (a: Artifact): InvestigationSummary => {
  const parsed = parseInvestigation(a.content);
  return {
    version: a.version,
    createdAt: a.createdAt,
    runId: a.provenance.runId,
    validation: a.provenance.validation ?? null,
    planHash: parsed.ok ? parsed.investigation.planHash : null,
    baseCommit: parsed.ok ? parsed.investigation.baseCommit : null,
    files: parsed.ok ? parsed.investigation.files.map((f) => f.path) : [],
    riskTier: parsed.ok ? parsed.investigation.riskTier : null,
    confidence: parsed.ok ? parsed.investigation.confidence : null,
    needsHuman: parsed.ok ? parsed.investigation.needsHuman.needed : null,
  };
};

export interface InboxContextItem {
  readonly id: number;
  readonly title: string;
  readonly sourceLabel: string;
  readonly occurredAt: string;
  readonly summary: string | null;
  readonly url: string;
  readonly text: string;
  readonly truncated: boolean;
}

/** What `get_context` tells an agent about conflicting sources. */
export const AUTHORITY_STATEMENT =
  'When sources disagree: merged code and the implementation record win, then current choices (newest first), then plan.md, then older discussion. Replaced choices are history: read them for why, not for what to do. Accepted decisions in scopedDecisions govern this glob by their scope, broadest first.';

/** The most decisions one context bundle carries. */
const CONTEXT_DECISIONS = 30;

export interface ArtifactListing {
  readonly kind: ArtifactKind;
  readonly label: string;
  readonly version: number;
  readonly commitSha: string | null;
  /** Characters of content. */
  readonly size: number;
  /** The first line of the content, or the link. */
  readonly description: string;
}

/** Attachments with these labels always come inline: agents must follow them and pass them verbatim. */
const INLINE_LABELS = new Set(['clarifications', 'assumptions']);

/** `include` entries: a kind (`local_review`, `local_review`, ...), `attachment:<label>`, or `all`. */
const wanted = (include: readonly string[], a: Artifact): boolean =>
  include.includes('all') ||
  include.includes(a.kind) ||
  (a.kind === 'attachment' && include.some((i) => i.toLowerCase() === `attachment:${a.label}`.toLowerCase()));

const describe = (a: Artifact): string => {
  const line = a.content.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find((l) => l !== '');
  const text = line ?? a.link ?? '';
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

/** A result from a superseded routine run: recorded as ignored, not stored. */
export interface Ignored {
  readonly ignored: true;
  readonly reason: string;
}

export interface PutOptions {
  readonly commitSha: string | null;
  readonly runId: string | null;
  readonly agentSetVersion: number | null;
  /** Local reviews: the review cycle's figures, kept in the provenance (other kinds ignore them). */
  readonly reviewStats?: ReviewStats | null;
  /** plan.md only: the version the writer read (0 before the first is saved); a later one is refused. */
  readonly expectedPlanVersion?: number;
}

/** What an artifact write carries beyond the glob and the writer. */
interface NewArtifact {
  readonly kind: ArtifactKind;
  readonly label: string;
  readonly content: string;
  readonly link: string | null;
  readonly commitSha: string | null;
  readonly runId: string | null;
  readonly agentSetVersion: number | null;
  readonly reviewStats: ReviewStats | null;
  /** Who produced it, when the kind and run don't say (decision globs' plan.md from a channel). */
  readonly by?: Provenance['by'];
  /** File attachments: the stored file's facts. */
  readonly file?: AttachmentFile;
}

/**
 * Appends an artifact version with its provenance and `ArtifactAdded` event, in the caller's transaction (which has
 * checked the writer's access). The one write path for artifacts: `put` and the inbox's attach both use it. The
 * caller publishes `glob.artifacts` after the commit.
 */
export const addArtifact = async (tx: Tx, clock: Clock, glob: Glob, email: string, input: NewArtifact): Promise<Artifact> => {
  const { kind, label, content, link } = input;
  const globId = glob.id;
  // An investigation whose block doesn't validate is kept as text, with the reason beside it.
  const parsed = kind === 'investigation' ? parseInvestigation(content) : null;
  const provenance: Provenance = {
    by:
      input.by ??
      (input.runId !== null
        ? 'routine'
        : kind === 'implementation_plan' || kind === 'local_review' || kind === 'investigation' || kind === 'assessment'
          ? 'sessionator'
          : 'human'),
    actor: email,
    runId: input.runId,
    agentSetVersion: input.agentSetVersion,
    ...(kind === 'local_review' && input.reviewStats !== null && { reviewStats: input.reviewStats }),
    ...(parsed !== null && !parsed.ok && { validation: validationNote(parsed.errors) }),
  };
  const now = clock.now();
  const artifact = await tx.insertArtifact({
    globId,
    kind,
    label,
    content,
    link,
    commitSha: input.commitSha,
    provenance,
    createdAt: now,
    ...(input.file === undefined ? {} : { file: input.file }),
  });
  // Queued for the findings pipeline in the same transaction; nothing is parsed or asked here.
  if (kind === 'local_review') {
    await tx.insertReviewSource({
      boardId: glob.boardId,
      globId,
      kind: 'local_review',
      artifactId: artifact.id,
      externalId: null,
      commitSha: input.commitSha,
      agentSetVersion: input.agentSetVersion,
      content: null,
      path: null,
      line: null,
      createdAt: now,
    });
  }
  await tx.appendEvents([
    {
      type: 'ArtifactAdded',
      globId,
      actor: email,
      at: now,
      data: { kind, label, version: artifact.version, commitSha: input.commitSha, runId: input.runId, agentSetVersion: input.agentSetVersion },
    },
  ]);
  return artifact;
};

/** A link attachment on a glob in the caller's transaction (the inbox's attach); the caller publishes `glob.artifacts` after commit. */
export const addAttachment = (
  tx: Tx,
  clock: Clock,
  glob: Glob,
  email: string,
  input: { readonly label: string; readonly content: string; readonly link: string | null },
): Promise<Artifact> =>
  addArtifact(tx, clock, glob, email, { kind: 'attachment', ...input, commitSha: null, runId: null, agentSetVersion: null, reviewStats: null });

/**
 * Glob artifacts: plan.md, the implementation record (stored as kind `implementation_plan`), local reviews and attachments,
 * kept as versioned records with provenance. Writes are append-style: they carry no glob
 * version, and results from a superseded routine run are ignored.
 */
export class ArtifactService {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      notifier: Notifier;
      /** Ranked material related to a glob, for `get_context`; runs in the context transaction. */
      related?: (tx: Tx, glob: Glob) => Promise<readonly SearchHit[]>;
      /** The board's conflict hotspots at `now` (`HotspotService.hotspots`), for `get_context`. */
      hotspots?: (boardId: number, now: string) => Promise<{ readonly windowDays: number; readonly hotspots: readonly Hotspot[] }>;
      /** Re-judges a glob's size when its plan.md is saved in Planning. */
      sizeCheck?: SizeAssessor;
      /** Re-infers a glob's relations after its plan or investigation changed; never throws. */
      dependencyInference?: { refresh(globId: string): Promise<void> };
      /** Acts on a stored investigation (escalate, oversize flag) before the save returns. */
      investigation?: InvestigationReactor;
      /** `GlobService.reconcileRollout`: turns a stored implementation record's `## Rollout` section into the glob's rollout steps. */
      rollout?: (
        email: string,
        globId: string,
        record: string,
        source: { readonly commitSha: string | null; readonly runId: string | null; readonly agentSetVersion: number | null },
      ) => Promise<void>;
    },
  ) {}

  /**
   * Stores an independent review as a new version of the glob's `independent_review` artifact, tied to the reviewed commit.
   * A system write (no person acts): `model` names the reviewer. Not found when the glob is gone.
   */
  async addIndependentReview(
    globId: string,
    input: { readonly content: string; readonly commitSha: string; readonly meta: IndependentReviewMeta; readonly model: string },
  ): Promise<Result<Artifact>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<{ artifact: Artifact; boardId: number }>> => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const now = this.deps.clock.now();
      const provenance: Provenance = { by: 'reviewer', actor: input.model, runId: null, agentSetVersion: null, independentReview: input.meta };
      const artifact = await tx.insertArtifact({ globId, kind: 'independent_review', label: '', content: input.content, link: null, commitSha: input.commitSha, provenance, createdAt: now });
      await tx.appendEvents([
        { type: 'ArtifactAdded', globId, actor: null, at: now, data: { kind: 'independent_review', label: '', version: artifact.version, commitSha: input.commitSha, stage: input.meta.stage, findings: input.meta.findings } },
      ]);
      return ok({ artifact, boardId: glob.boardId });
    });
    if (!result.ok) return result;
    this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: result.value.boardId, globId });
    return ok(result.value.artifact);
  }

  /** `save_plan` and `PUT /globs/{id}/plan`: a new plan.md version, conditional on `version` when given. */
  async putPlan(email: string, globId: string, content: string, version?: number): Promise<Result<Artifact | Ignored>> {
    return this.put(email, globId, 'plan', '', content, null, {
      commitSha: null,
      runId: null,
      agentSetVersion: null,
      ...(version === undefined ? {} : { expectedPlanVersion: version }),
    });
  }

  async attach(
    email: string,
    globId: string,
    input: { label: string; text: string | null; link: string | null },
  ): Promise<Result<Artifact | Ignored>> {
    if ((input.text ?? '').trim() === '' && (input.link ?? '').trim() === '') {
      return invalidInput('An attachment needs text or a link');
    }
    if (input.label.trim() === '') return invalidInput('An attachment needs a label');
    return this.put(email, globId, 'attachment', input.label.trim(), input.text ?? '', input.link, {
      commitSha: null,
      runId: null,
      agentSetVersion: null,
    });
  }

  /**
   * `put_artifact`: the implementation record, local reviews and investigations from implementers. `postplan` is an alias that writes
   * the record, so agent sets that haven't been refreshed keep working.
   */
  async putArtifact(
    email: string,
    globId: string,
    kind: 'implementation_plan' | 'postplan' | 'local_review' | 'investigation',
    content: string,
    options: PutOptions,
  ): Promise<Result<Artifact | Ignored>> {
    if (content.trim() === '') return invalidInput('An artifact needs content');
    return this.put(email, globId, kind === 'postplan' ? 'implementation_plan' : kind, '', content, null, options);
  }

  /** `get_plan`: plan.md with its version history. */
  async plan(
    email: string,
    globId: string,
    version: number | null,
  ): Promise<Result<{ kind: ArtifactKind; current: Artifact | null; versions: { version: number; createdAt: string; by: string }[] }>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const kind: ArtifactKind = 'plan';
      const versions = await tx.artifactVersions(globId, kind, '');
      const current = version === null ? (versions.at(-1) ?? null) : (versions.find((v) => v.version === version) ?? null);
      if (version !== null && current === null) return notFound(`${globId} has no ${kind} version ${version}`);
      return ok({
        kind,
        current,
        versions: versions.map((v) => ({ version: v.version, createdAt: v.createdAt, by: v.provenance.actor })),
      });
    });
  }

  async list(email: string, globId: string): Promise<Result<Artifact[]>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      return ok(await tx.listArtifacts(globId));
    });
  }

  /** Every version of one artifact (kind and label), oldest first, with content. */
  async versions(email: string, globId: string, kind: ArtifactKind, label: string): Promise<Result<Artifact[]>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      return ok(await tx.artifactVersions(globId, kind, label));
    });
  }

  /**
   * `get_context` (basic): the glob, its plan.md and implementation record in full, Clarifications and Assumptions in full, and a listing of
   * every other artifact. `include` returns more in full. `related` adds ranked search results when search is configured.
   */
  async context(email: string, globId: string, include: readonly string[] = []): Promise<Result<GlobContext>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const board = await tx.getBoard(glob.boardId);
      if (board === null) return notFound(`No board ${glob.boardId}`);
      const artifacts = await tx.listArtifacts(globId);
      const latest = (kind: ArtifactKind) => artifacts.find((a) => a.kind === kind) ?? null;
      const plan = latest('plan');
      const record = latest('implementation_plan');
      const investigation = latest('investigation');
      // listArtifacts returns the latest version of each (kind, label).
      const full = (a: Artifact) =>
        (a.kind === 'attachment' && INLINE_LABELS.has(a.label.toLowerCase())) || wanted(include, a);
      // Legacy postplan rows were migrated into the record; they stay as history, not listed.
      const others = artifacts.filter((a) => ARTIFACT_ROLE[a.kind] !== 'payload' && ARTIFACT_ROLE[a.kind] !== 'record' && !full(a));
      const related = this.deps.related === undefined ? undefined : await this.deps.related(tx, glob);
      const allDecisions = await tx.listDecisions(glob.boardId);
      const decisions = decisionViews(
        allDecisions.filter((d) => d.globId === globId),
        allDecisions,
      )
        // Current first (stable: each group stays newest first).
        .sort((a, b) => Number(a.status === 'superseded') - Number(b.status === 'superseded'))
        .slice(0, CONTEXT_DECISIONS);
      const sizeCheck = await tx.getSizeCheck(globId);
      const running = investigationRunning(glob);
      const scopedDecisions = await governingDecisions(tx, glob);
      const inbox = (await tx.listInboxForGlob(globId)).map((i) => ({
        id: i.id,
        title: inboxTitle(i),
        sourceLabel: i.sourceLabel,
        occurredAt: i.occurredAt,
        summary: i.summary,
        url: inboxLink(i.boardId, i.id),
        text: i.text.slice(0, INBOX_CONTEXT_CHARS),
        truncated: i.text.length > INBOX_CONTEXT_CHARS,
      }));
      const group = await this.groupSection(tx, glob);
      const hotspotView = this.deps.hotspots === undefined ? null : await this.deps.hotspots(glob.boardId, this.deps.clock.now());
      return ok({
        glob: {
          id: glob.id,
          title: glob.title,
          type: glob.type,
          category: glob.category,
          group: glob.group,
          environment: glob.environment,
          status: glob.status,
        },
        board: { id: board.id, repo: board.repo, baseBranch: board.baseBranch },
        plan: plan === null ? null : { version: plan.version, content: plan.content },
        payload: payloadOf(artifacts),
        ...(glob.attributes === undefined ? {} : { attributes: glob.attributes }),
        scopedDecisions,
        implementationRecord:
          record === null ? null : { version: record.version, commitSha: record.commitSha, content: record.content },
        attachments: artifacts
          .filter((a) => a.kind === 'attachment' && full(a) && (a.file === undefined || a.file === null))
          .map((a) => ({ label: a.label, content: a.content, link: a.link })),
        files: artifacts.flatMap((a) =>
          a.kind !== 'attachment' || a.file === undefined || a.file === null
            ? []
            : [
                {
                  label: a.label,
                  fileName: a.file.fileName,
                  contentType: a.file.contentType,
                  size: a.file.size,
                  state: a.file.state,
                  ...(a.file.state === 'missing' ? { note: missingFileNote(a) ?? '' } : {}),
                },
              ],
        ),
        available: [
          ...others.filter((a) => a.file === undefined || a.file === null).map((a) => ({
            kind: a.kind,
            label: a.label,
            version: a.version,
            commitSha: a.commitSha,
            size: a.content.length,
            description: describe(a),
          })),
        ],
        ...(related === undefined ? {} : { related }),
        ...(investigation === null ? {} : { investigation: investigationSummary(investigation) }),
        ...(running === null ? {} : { investigationRunning: running }),
        decisions,
        inbox,
        handover: await handoverOf(tx, this.deps.clock, glob),
        authority: AUTHORITY_STATEMENT,
        humanSteps: humanSteps(glob, {}, await tx.listHumanSteps(glob.boardId, [globId])),
        ...(hotspotView === null
          ? {}
          : {
              hotspots: hotspotsOfGlob(
                hotspotView,
                globId,
                investigation === null ? [] : investigationSummary(investigation).files,
                plan?.content ?? '',
              ),
            }),
        ...(sizeCheck === null ? {} : { size: sizeContext(sizeCheck) }),
        ...(group === null ? {} : { group }),
        fetch:
          "Not in full: call get_artifact(id, kind, label?) for one, or get_context(id, include: ['local_review', 'attachment:<label>', 'all']). Inbox items are attached notes: their text is cut at 12000 characters (truncated: true); search_text finds the rest.",
      });
    });
  }

  /** The group section of a glob's context: its neighbours and open decisions; null when it has none. */
  private async groupSection(tx: Tx, glob: Glob): Promise<GroupContext | null> {
    if (glob.group === null) return null;
    const all = await tx.listGlobs(glob.boardId, { include: 'all' });
    const members = all.filter((g) => inGroup(g, glob.group ?? '') && !isArchivedDecision(g));
    const relations = await tx.listRelationsFrom(members.filter((g) => g.category !== 'decision').map((g) => g.id));
    const memberIds = new Set(members.map((g) => g.id));
    const others = await tx.getGlobs([...new Set(relations.map((r) => r.to))].filter((id) => !memberIds.has(id)));
    const plans = new Map<string, string>();
    for (const g of members) {
      if (g.id === glob.id || g.category === 'decision') continue;
      const plan = (await tx.listArtifacts(g.id, 'plan'))[0];
      if (plan !== undefined) plans.set(g.id, plan.content);
    }
    return groupContext(glob, members, relations, plans, others.filter((g) => g.category === 'decision'), this.deps.clock.now());
  }

  /** The latest version of one artifact (kind and, for attachments, label) in full. */
  async artifact(email: string, globId: string, kind: ArtifactKind, label: string): Promise<Result<Artifact>> {
    const versions = await this.versions(email, globId, kind, label);
    if (!versions.ok) return versions;
    const latest = versions.value.at(-1);
    return latest === undefined ? notFound(`${globId} has no ${kind}${label === '' ? '' : ` "${label}"`}`) : ok(latest);
  }

  private async put(
    email: string,
    globId: string,
    kind: ArtifactKind,
    label: string,
    content: string,
    link: string | null,
    options: PutOptions,
  ): Promise<Result<Artifact | Ignored>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<{ artifact: Artifact | Ignored; boardId: number }>> => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      if (options.runId !== null) {
        const run = currentRun(glob);
        if (run === null || run.id !== options.runId || run.state === 'ended') {
          return ok({
            artifact: { ignored: true as const, reason: `Run ${options.runId} is not the glob's current run` },
            boardId: glob.boardId,
          });
        }
      }
      if (kind === 'plan' && options.expectedPlanVersion !== undefined) {
        const latest = (await tx.artifactVersions(globId, 'plan', '')).at(-1)?.version ?? 0;
        if (latest !== options.expectedPlanVersion) {
          return err({
            code: 'version_conflict',
            message: `plan.md is at version ${String(latest)}, not ${String(options.expectedPlanVersion)}: read it again and retry`,
            current: glob,
          });
        }
      }
      const artifact = await addArtifact(tx, this.deps.clock, glob, email, {
        kind,
        label,
        content,
        link,
        commitSha: options.commitSha,
        runId: options.runId,
        agentSetVersion: options.agentSetVersion,
        reviewStats: options.reviewStats ?? null,
      });
      // A plan that now names (or stops naming) an exclusive path changes which globs overlap.
      if (kind === 'plan') await tx.enqueueEffects([recheckOverlapsEffect(glob.boardId)]);
      return ok({ artifact, boardId: glob.boardId });
    });
    if (!result.ok) return result;
    const { artifact, boardId } = result.value;
    // Artifacts don't bump the glob's version, so open boards get their own hint kind.
    if (!('ignored' in artifact)) {
      this.deps.notifier.publish({ kind: 'glob.artifacts', boardId, globId });
      // Not awaited: the model's judgement must not hold up a save. It never throws and publishes when it has written.
      if (kind === 'plan') void this.deps.sizeCheck?.refresh(globId);
      // Likewise the dependency tree: a changed plan (or an investigation that read the code) may change what the glob needs.
      if (kind === 'plan' || kind === 'investigation') void this.deps.dependencyInference?.refresh(globId);
      // A queued review shows as being read in an open glob view straight away.
      if (kind === 'local_review') this.deps.notifier.publish({ kind: 'glob.findings', boardId, globId });
      // Awaited: slop flags the glob before the run goes on to implement.
      if (kind === 'investigation') await this.deps.investigation?.react(email, globId, options.runId, content);
      // Awaited: the record's rollout steps are on the glob when the save returns, so a merge right after finds them.
      if (kind === 'implementation_plan') {
        await this.deps.rollout?.(email, globId, content, { commitSha: options.commitSha, runId: options.runId, agentSetVersion: options.agentSetVersion });
      }
    }
    return ok(artifact);
  }
}
