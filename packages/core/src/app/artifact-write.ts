import { parseInvestigation, validationNote } from '../domain/investigation.js';
import { parseTestPlan, testPlanNote } from '../domain/test-plan.js';
import { parseWorkstreams, sameWorkstreams, workstreamsEventData, workstreamsValidationNote } from '../domain/workstreams.js';
import type { AttachmentFile } from '../domain/attachment-file.js';
import type { Artifact, ArtifactKind, Provenance, ReviewStats } from '../domain/knowledge.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Tx } from '../ports.js';

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
  /** plan.md and the test plan: the version the writer read (0 before the first is saved); a later one is refused. */
  readonly expectedVersion?: number;
  /** The same as `expectedVersion`, under its old name (plan.md only then). */
  readonly expectedPlanVersion?: number;
}

/** What an artifact write carries beyond the glob and the writer. */
export interface NewArtifact {
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
  // A test plan with problems is kept as text with the notes beside it; its parsed spec list is stored so readers don't parse again.
  const plan = kind === 'test_plan' ? parseTestPlan(content) : null;
  const planNote = plan === null ? null : testPlanNote(plan.notes);
  // Likewise a record whose workstreams block doesn't validate. A record without the section (a small glob) has nothing to say.
  const workstreams = kind === 'implementation_plan' ? parseWorkstreams(content) : null;
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
    ...(planNote !== null && { validation: planNote }),
    ...(plan !== null && plan.atf !== null && { atfSpecs: plan.atf }),
    ...(workstreams?.kind === 'invalid' && { validation: workstreamsValidationNote(workstreams.errors) }),
  };
  const now = clock.now();
  // Read the previous record under the artifact lock, so two pushes can't both see the same "previous" block.
  let previous: ReturnType<typeof parseWorkstreams> | null = null;
  if (workstreams?.kind === 'ok') {
    await tx.lockGlobArtifacts(globId);
    // The last version whose block parsed, so a malformed push in between doesn't make the same block look new again.
    for (const v of (await tx.artifactVersions(globId, 'implementation_plan', '')).reverse()) {
      const p = parseWorkstreams(v.content);
      if (p.kind === 'ok') {
        previous = p;
        break;
      }
    }
  }
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
    // Only a changed block is an event, so re-pushing the same record doesn't pile them up; consumers read the latest per glob.
    ...(workstreams?.kind === 'ok' && !(previous?.kind === 'ok' && sameWorkstreams(previous.block, workstreams.block))
      ? [
          {
            type: 'WorkstreamsRecorded' as const,
            globId,
            actor: email,
            at: now,
            data: workstreamsEventData(workstreams.block, { version: artifact.version, commitSha: input.commitSha, runId: input.runId }),
          },
        ]
      : []),
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
