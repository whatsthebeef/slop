import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { Artifact, ArtifactKind, Provenance } from '../domain/knowledge.js';
import { currentRun } from '../domain/machine.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Notifier, Store } from '../ports.js';
import { memberOf } from './access.js';

export interface GlobContext {
  readonly glob: Pick<Glob, 'id' | 'title' | 'summary' | 'type' | 'category' | 'group' | 'environment' | 'status'>;
  readonly board: { readonly id: number; readonly repo: string | null; readonly baseBranch: string };
  /** plan.md (a super's postplan once it has one): the latest version, or the summary when no plan has been written yet. */
  readonly plan: { readonly version: number; readonly content: string } | null;
  readonly implementationPlan: { readonly version: number; readonly content: string } | null;
  readonly attachments: readonly { readonly label: string; readonly content: string; readonly link: string | null }[];
}

/** A result from a superseded routine run: recorded as ignored, not stored. */
export interface Ignored {
  readonly ignored: true;
  readonly reason: string;
}

export interface PutOptions {
  readonly commitSha: string | null;
  readonly runId: string | null;
  readonly agentSetVersion: number | null;
}

/**
 * Glob artifacts: plan.md, the implementation plan, postplans, local reviews and attachments,
 * kept as versioned records with provenance. Writes are append-style: they carry no glob
 * version, and results from a superseded routine run are ignored.
 */
export class ArtifactService {
  constructor(private readonly deps: { store: Store; clock: Clock; notifier: Notifier }) {}

  async putPlan(email: string, globId: string, content: string): Promise<Result<Artifact | Ignored>> {
    return this.put(email, globId, 'plan', '', content, null, { commitSha: null, runId: null, agentSetVersion: null });
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

  /** `put_artifact`: implementation plans, postplans and local reviews from implementers. */
  async putArtifact(
    email: string,
    globId: string,
    kind: 'implementation_plan' | 'postplan' | 'local_review',
    content: string,
    options: PutOptions,
  ): Promise<Result<Artifact | Ignored>> {
    if (content.trim() === '') return invalidInput('An artifact needs content');
    return this.put(email, globId, kind, '', content, null, options);
  }

  /** `get_plan`: plan.md (or a super's postplan, once it has one) with its version history. */
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
      // A super's postplan replaces plan.md once it exists; until then plan.md is its plan.
      const postplans = glob.type === 'super' ? await tx.artifactVersions(globId, 'postplan', '') : [];
      const kind: ArtifactKind = postplans.length > 0 ? 'postplan' : 'plan';
      const versions = kind === 'postplan' ? postplans : await tx.artifactVersions(globId, kind, '');
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

  /** `get_context` (basic): the glob, plan.md and attachments. Decisions, meetings and search come in slice 8. */
  async context(email: string, globId: string): Promise<Result<GlobContext>> {
    return this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const board = await tx.getBoard(glob.boardId);
      if (board === null) return notFound(`No board ${glob.boardId}`);
      const artifacts = await tx.listArtifacts(globId);
      const latest = (kind: ArtifactKind) => artifacts.find((a) => a.kind === kind) ?? null;
      // A super's postplan replaces plan.md once it exists; until then plan.md is its plan.
      const plan = (glob.type === 'super' ? latest('postplan') : null) ?? latest('plan');
      const implementation = latest('implementation_plan');
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
        implementationPlan:
          implementation === null ? null : { version: implementation.version, content: implementation.content },
        attachments: artifacts
          .filter((a) => a.kind === 'attachment')
          .map((a) => ({ label: a.label, content: a.content, link: a.link })),
      });
    });
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
      const provenance: Provenance = {
        by: options.runId !== null ? 'routine' : kind === 'postplan' || kind === 'local_review' ? 'sessionator' : 'human',
        actor: email,
        runId: options.runId,
        agentSetVersion: options.agentSetVersion,
      };
      const now = this.deps.clock.now();
      const artifact = await tx.insertArtifact({
        globId,
        kind,
        label,
        content,
        link,
        commitSha: options.commitSha,
        provenance,
        createdAt: now,
      });
      // Queued for the findings pipeline in the same transaction; nothing is parsed or asked here.
      if (kind === 'local_review') {
        await tx.insertReviewSource({
          boardId: glob.boardId,
          globId,
          kind: 'local_review',
          artifactId: artifact.id,
          externalId: null,
          commitSha: options.commitSha,
          agentSetVersion: options.agentSetVersion,
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
          data: {
            kind,
            label,
            version: artifact.version,
            commitSha: options.commitSha,
            runId: options.runId,
            agentSetVersion: options.agentSetVersion,
          },
        },
      ]);
      return ok({ artifact, boardId: glob.boardId });
    });
    if (!result.ok) return result;
    const { artifact, boardId } = result.value;
    // Artifacts don't bump the glob's version, so open boards get their own hint kind.
    if (!('ignored' in artifact)) {
      this.deps.notifier.publish({ kind: 'glob.artifacts', boardId, globId });
      // A queued review shows as being read in an open glob view straight away.
      if (kind === 'local_review') this.deps.notifier.publish({ kind: 'glob.findings', boardId, globId });
    }
    return ok(artifact);
  }
}
