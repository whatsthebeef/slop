import { missingFileNote } from '../domain/attachment-file.js';
import { err, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { ARTIFACT_ROLE } from '../domain/knowledge.js';
import type { Artifact, ArtifactKind, IndependentReviewMeta, Provenance } from '../domain/knowledge.js';
import { payloadOf } from '../domain/payload.js';
import { testPlanSpecs } from '../domain/test-plan.js';
import { recheckOverlapsEffect } from '../domain/events.js';
import { humanSteps } from '../domain/human-steps.js';
import { currentRun, investigationRunning } from '../domain/machine.js';
import type { Hotspot } from '../domain/hotspots.js';
import type { SearchHit } from '../domain/search.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Notifier, Store, Tx } from '../ports.js';
import { memberOf } from './access.js';
import { addArtifact } from './artifact-write.js';
import type { Ignored, PutOptions } from './artifact-write.js';
import { INLINE_LABELS, describe, wanted } from './context/artifact-listing.js';
import { AUTHORITY_STATEMENT, decisionsOfGlob, governingDecisions } from './context/decision-section.js';
import type { GlobContext } from './context/glob-context.js';
import { groupSection, handoverOf } from './context/handover-section.js';
import { hotspotsOfGlob } from './context/hotspot-section.js';
import { inboxSection } from './context/inbox-section.js';
import { investigationSummary } from './context/investigation-section.js';
import { sizeContext } from './context/size-section.js';
import type { InvestigationReactor } from './investigation-service.js';
import type { SizeAssessor } from './size-check-service.js';

// The pieces moved out of this file stay importable from here.
export { addArtifact, addAttachment } from './artifact-write.js';
export type { Ignored, NewArtifact, PutOptions } from './artifact-write.js';
export { handoverOf } from './context/handover-section.js';
export { AUTHORITY_STATEMENT, governingDecisions } from './context/decision-section.js';
export { FORECAST_NOTE } from './context/size-section.js';
export type { SizeContext, SizeForecastContext } from './context/size-section.js';
export type { ArtifactListing } from './context/artifact-listing.js';
export type { GlobHotspot } from './context/hotspot-section.js';
export type { InboxContextItem } from './context/inbox-section.js';
export type { InvestigationSummary } from './context/investigation-section.js';
export type { GlobContext } from './context/glob-context.js';

/** A versioned document (plan.md, the test plan) with its history, newest as `current`. */
export interface VersionedDoc {
  readonly kind: ArtifactKind;
  readonly current: Artifact | null;
  readonly versions: { version: number; createdAt: string; by: string }[];
}

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
      ...(version === undefined ? {} : { expectedVersion: version }),
    });
  }

  /** `save_test_plan` and `PUT /globs/{id}/test-plan`: a new test plan version, conditional on `version` when given. */
  async putTestPlan(email: string, globId: string, content: string, version?: number): Promise<Result<Artifact | Ignored>> {
    return this.put(email, globId, 'test_plan', '', content, null, {
      commitSha: null,
      runId: null,
      agentSetVersion: null,
      ...(version === undefined ? {} : { expectedVersion: version }),
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
    kind: 'implementation_plan' | 'postplan' | 'local_review' | 'investigation' | 'test_plan',
    content: string,
    options: PutOptions,
  ): Promise<Result<Artifact | Ignored>> {
    if (content.trim() === '') return invalidInput('An artifact needs content');
    return this.put(email, globId, kind === 'postplan' ? 'implementation_plan' : kind, '', content, null, options);
  }

  /** `get_plan`: plan.md with its version history. */
  plan(email: string, globId: string, version: number | null): Promise<Result<VersionedDoc>> {
    return this.versionedDoc(email, globId, 'plan', version);
  }

  /** `get_test_plan`: the test plan with its version history (`current` null before the first is saved). */
  testPlan(email: string, globId: string, version: number | null): Promise<Result<VersionedDoc>> {
    return this.versionedDoc(email, globId, 'test_plan', version);
  }

  private async versionedDoc(email: string, globId: string, kind: 'plan' | 'test_plan', version: number | null): Promise<Result<VersionedDoc>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
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
      const testPlan = latest('test_plan');
      // listArtifacts returns the latest version of each (kind, label).
      const full = (a: Artifact) =>
        (a.kind === 'attachment' && INLINE_LABELS.has(a.label.toLowerCase())) || wanted(include, a);
      // Legacy postplan rows were migrated into the record; they stay as history, not listed.
      const others = artifacts.filter((a) => ARTIFACT_ROLE[a.kind] !== 'payload' && ARTIFACT_ROLE[a.kind] !== 'record' && !full(a));
      const related = this.deps.related === undefined ? undefined : await this.deps.related(tx, glob);
      const decisions = await decisionsOfGlob(tx, glob);
      const sizeCheck = await tx.getSizeCheck(globId);
      const running = investigationRunning(glob);
      const scopedDecisions = await governingDecisions(tx, glob);
      const inbox = await inboxSection(tx, globId);
      const group = await groupSection(tx, this.deps.clock, glob);
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
        testPlan:
          testPlan === null
            ? null
            : {
                version: testPlan.version,
                content: testPlan.content,
                atfSpecs: testPlanSpecs(testPlan),
                validation: testPlan.provenance.validation ?? null,
              },
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
        ...(sizeCheck === null ? {} : { size: sizeContext(sizeCheck, (await tx.getSizeThreshold(glob.boardId)).minParallel) }),
        ...(group === null ? {} : { group }),
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
      const expected = options.expectedVersion ?? options.expectedPlanVersion;
      if ((kind === 'plan' || kind === 'test_plan') && expected !== undefined) {
        const latest = (await tx.artifactVersions(globId, kind, '')).at(-1)?.version ?? 0;
        if (latest !== expected) {
          return err({
            code: 'version_conflict',
            message: `${kind === 'plan' ? 'plan.md' : 'The test plan'} is at version ${String(latest)}, not ${String(expected)}: read it again and retry`,
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
