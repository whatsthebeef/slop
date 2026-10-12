import { decisionViews } from '../domain/decisions.js';
import type { DecisionView } from '../domain/decisions.js';
import { parseInvestigation, validationNote } from '../domain/investigation.js';
import { err, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { INBOX_CONTEXT_CHARS, inboxLink, inboxTitle } from '../domain/inbox.js';
import { ARTIFACT_ROLE } from '../domain/knowledge.js';
import type { Artifact, ArtifactKind, IndependentReviewMeta, Provenance, ReviewStats } from '../domain/knowledge.js';
import { applicableDecisions, scopedDecision } from '../domain/decision-glob.js';
import type { ScopedDecision } from '../domain/decision-glob.js';
import { payloadOf } from '../domain/payload.js';
import type { Payload } from '../domain/payload.js';
import type { GlobAttributes } from '../domain/attributes.js';
import { recheckOverlapsEffect } from '../domain/events.js';
import { currentRun } from '../domain/machine.js';
import type { SearchHit } from '../domain/search.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Notifier, Store, Tx } from '../ports.js';
import { memberOf } from './access.js';
import type { InvestigationReactor } from './investigation-service.js';
import type { SizeAssessor } from './size-check-service.js';
import type { SizeCheck } from '../domain/size-check.js';
import type { SizeForecast } from '../domain/size-forecast.js';

export interface GlobContext {
  readonly glob: Pick<Glob, 'id' | 'title' | 'summary' | 'type' | 'category' | 'group' | 'environment' | 'status'>;
  readonly board: { readonly id: number; readonly repo: string | null; readonly baseBranch: string };
  /** plan.md: the latest version, or the summary when no plan has been written yet. */
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
  /** Every other artifact, not in full: fetch one with `get_artifact` or `include` on `get_context`. */
  readonly available: readonly ArtifactListing[];
  /**
   * What the board already knows about this glob's title and summary (current mode, top 5, cited, the glob's own
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
  /** Which source wins when sources disagree (the spec's order of authority). */
  readonly authority: string;
  /** Present when intake judged the glob: the oversized flag, its reasons and the proposed split (apply it with split_glob). */
  readonly size?: SizeContext;
  readonly fetch: string;
}

export interface SizeContext {
  readonly oversized: boolean;
  readonly reasons: readonly string[];
  readonly evidence: readonly string[];
  /** What a person did about the flag: `kept_whole`, or `split`; null while it is unresolved. */
  readonly decision: SizeCheck['decision'];
  /** Parts in the shape split_glob takes (part 0 is this glob; `after` holds earlier part indexes). */
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
  const artifact = await tx.insertArtifact({ globId, kind, label, content, link, commitSha: input.commitSha, provenance, createdAt: now });
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
      /** Re-judges a glob's size when its plan.md is saved in Planning. */
      sizeCheck?: SizeAssessor;
      /** Acts on a stored investigation (escalate, oversize flag) before the save returns. */
      investigation?: InvestigationReactor;
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
      const scopedDecisions = applicableDecisions(await tx.listGlobs(glob.boardId, { include: 'decisions' }), glob)
        .map(scopedDecision)
        .filter((d): d is ScopedDecision => d !== null);
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
      return ok({
        glob: {
          id: glob.id,
          title: glob.title,
          summary: glob.summary,
          type: glob.type,
          category: glob.category,
          group: glob.group,
          environment: glob.environment,
          status: glob.status,
        },
        board: { id: board.id, repo: board.repo, baseBranch: board.baseBranch },
        plan:
          plan !== null
            ? { version: plan.version, content: plan.content }
            : glob.summary.trim() === ''
              ? null
              : { version: 0, content: glob.summary },
        payload: payloadOf(artifacts, glob),
        ...(glob.attributes === undefined ? {} : { attributes: glob.attributes }),
        scopedDecisions,
        implementationRecord:
          record === null ? null : { version: record.version, commitSha: record.commitSha, content: record.content },
        attachments: artifacts
          .filter((a) => a.kind === 'attachment' && full(a))
          .map((a) => ({ label: a.label, content: a.content, link: a.link })),
        available: [
          ...others.map((a) => ({
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
        decisions,
        inbox,
        authority: AUTHORITY_STATEMENT,
        ...(sizeCheck === null ? {} : { size: sizeContext(sizeCheck) }),
        fetch:
          "Not in full: call get_artifact(id, kind, label?) for one, or get_context(id, include: ['local_review', 'attachment:<label>', 'all']). Inbox items are attached notes: their text is cut at 12000 characters (truncated: true); search_text finds the rest.",
      });
    });
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
      // A queued review shows as being read in an open glob view straight away.
      if (kind === 'local_review') this.deps.notifier.publish({ kind: 'glob.findings', boardId, globId });
      // Awaited: slop flags the glob before the run goes on to implement.
      if (kind === 'investigation') await this.deps.investigation?.react(email, globId, options.runId, content);
    }
    return ok(artifact);
  }
}
