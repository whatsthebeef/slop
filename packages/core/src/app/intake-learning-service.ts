import { notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { DomainEvent } from '../domain/events.js';
import {
  OUTCOME_EVENT_TYPES,
  collectOutcome,
  extractPlanFeatures,
  intakeAccuracy,
  outcomeDue,
  selectExamples,
} from '../domain/intake-learning.js';
import type { ExampleCandidate, IntakeAccuracy, IntakeExample, IntakeRecord, IntakeSnapshot, SnapshotSource } from '../domain/intake-learning.js';
import type { ReviewStats } from '../domain/knowledge.js';
import type { BoardJobResult } from '../domain/signals.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Embedder, Store, Tx } from '../ports.js';
import { memberOf } from './access.js';

export type IntakeOutcomeResult = Extract<BoardJobResult, { kind: 'intake_outcome' }>;

const EPOCH = '1970-01-01T00:00:00.000Z';
/** Snapshots embedded per batch, and the most per run (the rest wait for the next hourly run). */
const EMBED_BATCH = 25;
const MAX_EMBEDDED_PER_RUN = 200;
/** The embedder gets this long: a slow one must not hold up intake or creating a glob. */
export const EMBED_TIMEOUT_MS = 8000;

/** The text a snapshot is embedded by, and a new request is searched with: the request as written. */
export const embeddingText = (request: string): string => request.trim().slice(0, 4000);

/** The vector for a request, or null when there is no embedder, it is unavailable or it times out. Never throws. */
export const embedRequest = async (embedder: Embedder | undefined, request: string): Promise<number[] | null> => {
  if (embedder === undefined || request.trim() === '') return null;
  try {
    const [vector] = await embedder.embed([embeddingText(request)], AbortSignal.timeout(EMBED_TIMEOUT_MS));
    return vector ?? null;
  } catch {
    // Unavailable or failing: the snapshot's embedding is filled by the job later, and intake runs without examples.
    return null;
  }
};

/** The frozen record of what intake saw and decided for a glob just created (pure). */
export const snapshotOf = (
  glob: Glob,
  plan: string,
  intake: IntakeRecord | null,
  source: SnapshotSource,
  version = 1,
): IntakeSnapshot => ({
  globId: glob.id,
  version,
  boardId: glob.boardId,
  request: intake?.request ?? glob.summary,
  title: glob.title,
  summary: glob.summary,
  plan,
  creator: glob.creator,
  source: intake?.source ?? source,
  decisions: {
    type: glob.type,
    category: glob.category,
    group: glob.group,
    environment: glob.environment,
    categoryConfidence: intake?.categoryConfidence ?? null,
    reason: intake?.reason ?? null,
    model: intake?.model ?? null,
    promptVersion: intake?.promptVersion ?? null,
  },
  features: extractPlanFeatures(plan),
  examples: intake?.examples ?? [],
  backfilled: false,
  createdAt: glob.createdAt,
});

/**
 * The board's snapshots nearest to `embedding` with their outcomes, picked and ordered for the prompt (corrected first).
 * One snapshot per glob (its latest version).
 */
export const nearestExamples = async (tx: Tx, boardId: number, embedding: readonly number[]): Promise<IntakeExample[]> => {
  const near = await tx.nearestIntakeSnapshots(boardId, embedding, 40);
  if (near.length === 0) return [];
  const [snapshots, outcomes] = await Promise.all([tx.listLatestIntakeSnapshots(boardId), tx.listGlobOutcomes(boardId)]);
  const byGlob = new Map(snapshots.map((s) => [s.globId, s]));
  const outcomeOf = new Map(outcomes.map((o) => [o.globId, o]));
  const seen = new Set<string>();
  const candidates: ExampleCandidate[] = [];
  for (const n of near) {
    const snapshot = byGlob.get(n.globId);
    if (snapshot === undefined || seen.has(n.globId)) continue;
    seen.add(n.globId);
    candidates.push({ snapshot, outcome: outcomeOf.get(n.globId) ?? null, distance: n.distance });
  }
  return selectExamples(candidates);
};

/**
 * Learned task categorisation, the background half (spec, Intake): fills snapshot embeddings, rebuilds snapshots for globs
 * created before this existed (marked `backfilled`), and records each merged glob's outcome, refreshed once 14 days after
 * the merge. Runs hourly as the `intake_outcome` board job; everything is idempotent.
 */
export class IntakeLearningService {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      /** Absent: snapshots stay unembedded and intake shows no examples. */
      embedder?: Embedder;
    },
  ) {}

  async run(boardId: number, now: string): Promise<IntakeOutcomeResult> {
    const backfilled = await this.backfill(boardId);
    const embedded = await this.embedMissing(boardId);
    const { recorded, refreshed } = await this.recordOutcomes(boardId, now);
    return { kind: 'intake_outcome', backfilled, embedded, recorded, refreshed };
  }

  /** The board's intake accuracy, for members (the System page). */
  async accuracy(email: string, boardId: number): Promise<Result<IntakeAccuracy>> {
    return this.deps.store.transaction(async (tx) => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      if ((await tx.getBoard(boardId)) === null) return notFound(`No board ${boardId}`);
      return ok(intakeAccuracy(await tx.listLatestIntakeSnapshots(boardId), await tx.listGlobOutcomes(boardId)));
    });
  }

  /**
   * Snapshots for globs that have none: from plan.md v1 (else the summary) and the `GlobCreated` event's type and category.
   * Their intake fields are unknown, so they say nothing about intake's accuracy but still serve as examples.
   */
  private async backfill(boardId: number): Promise<number> {
    return this.deps.store.transaction(async (tx) => {
      const [globs, snapshots] = await Promise.all([tx.listGlobs(boardId, {}), tx.listLatestIntakeSnapshots(boardId)]);
      const has = new Set(snapshots.map((s) => s.globId));
      const missing = globs.filter((g) => !has.has(g.id));
      if (missing.length === 0) return 0;
      const created = new Map<string, DomainEvent>();
      for (const e of await tx.listBoardEvents(boardId, EPOCH, ['GlobCreated'])) created.set(e.globId, e);
      for (const glob of missing) {
        const plans = await tx.artifactVersions(glob.id, 'plan', '');
        const plan = plans.find((a) => a.version === 1)?.content ?? glob.summary;
        const data = created.get(glob.id)?.data;
        const type = data?.type === 'sub' || data?.type === 'same' || data?.type === 'super' ? data.type : glob.type;
        const category = data?.category === 'feature' || data?.category === 'task' || data?.category === 'bug' ? data.category : glob.category;
        const base = snapshotOf(glob, plan, null, 'backfill');
        await tx.insertIntakeSnapshot(
          {
            ...base,
            request: `${glob.title}\n${plan.trim() === '' ? glob.summary : plan}`.trim(),
            decisions: { ...base.decisions, type, category },
            backfilled: true,
          },
          null,
        );
      }
      return missing.length;
    });
  }

  /** Embeds snapshots that have no vector, a batch at a time; stops quietly when the embedder is unavailable. */
  private async embedMissing(boardId: number): Promise<number> {
    const { embedder } = this.deps;
    if (embedder === undefined) return 0;
    let done = 0;
    while (done < MAX_EMBEDDED_PER_RUN) {
      const batch = await this.deps.store.transaction((tx) => tx.snapshotsToEmbed(boardId, EMBED_BATCH));
      if (batch.length === 0) break;
      let vectors: number[][];
      try {
        vectors = await embedder.embed(batch.map((b) => embeddingText(b.request)), AbortSignal.timeout(EMBED_TIMEOUT_MS * 4));
      } catch {
        // Unavailable (credentials, access) or failing: the next hourly run tries again.
        break;
      }
      await this.deps.store.transaction(async (tx) => {
        for (const [i, row] of batch.entries()) {
          const vector = vectors[i];
          if (vector !== undefined) await tx.setSnapshotEmbedding(row.globId, row.version, vector);
        }
      });
      done += batch.length;
      if (vectors.length < batch.length) break;
    }
    return done;
  }

  private async recordOutcomes(boardId: number, now: string): Promise<{ recorded: number; refreshed: number }> {
    return this.deps.store.transaction(async (tx) => {
      const merges = new Map<string, string>();
      for (const e of await tx.listBoardEvents(boardId, EPOCH, ['Merged'])) merges.set(e.globId, e.at);
      if (merges.size === 0) return { recorded: 0, refreshed: 0 };
      const [snapshots, outcomes, globs] = await Promise.all([
        tx.listLatestIntakeSnapshots(boardId),
        tx.listGlobOutcomes(boardId),
        tx.listGlobs(boardId, {}),
      ]);
      const snapshotByGlob = new Map(snapshots.map((s) => [s.globId, s]));
      const outcomeOf = new Map(outcomes.map((o) => [o.globId, o]));
      const due = [...merges].filter(([globId, mergedAt]) => {
        if (!snapshotByGlob.has(globId)) return false;
        const existing = outcomeOf.get(globId) ?? null;
        // A glob merged again (Merge and continue) moves its merge date: its outcome is read again.
        return existing?.mergedAt !== mergedAt || outcomeDue(mergedAt, existing, now);
      });
      if (due.length === 0) return { recorded: 0, refreshed: 0 };
      const ids = new Set(due.map(([id]) => id));
      const events = new Map<string, DomainEvent[]>();
      for (const e of await tx.listBoardEvents(boardId, EPOCH, OUTCOME_EVENT_TYPES)) {
        if (ids.has(e.globId)) events.set(e.globId, [...(events.get(e.globId) ?? []), e]);
      }
      const reviews = new Map<string, ReviewStats>();
      for (const meta of await tx.listArtifactMeta(boardId, ['local_review'], EPOCH)) {
        if (ids.has(meta.globId) && meta.provenance.reviewStats !== undefined) reviews.set(meta.globId, meta.provenance.reviewStats);
      }
      const bugs = globs.filter((g) => g.category === 'bug');
      let recorded = 0;
      let refreshed = 0;
      for (const [globId, mergedAt] of due) {
        const snapshot = snapshotByGlob.get(globId);
        if (snapshot === undefined) continue;
        const outcome = collectOutcome({
          snapshot,
          events: events.get(globId) ?? [],
          mergedAt,
          now,
          reviewStats: reviews.get(globId) ?? null,
          findings: (await tx.listFindings(globId)).map((f) => ({ severity: f.severity, class: f.class })),
          bugs: bugs.map((b) => ({ id: b.id, title: b.title, summary: b.summary, createdAt: b.createdAt })),
        });
        await tx.upsertGlobOutcome(outcome);
        if (outcomeOf.has(globId)) refreshed++;
        else recorded++;
      }
      return { recorded, refreshed };
    });
  }
}
