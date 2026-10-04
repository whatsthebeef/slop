import type { Effect, EffectKind, Glob, GlobService } from '@slop/core';
import { machine } from '@slop/core';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { Db } from '../db/store.js';

/** What an executor did: done, or dropped because it no longer applies. Throwing means retry. */
export type Outcome = 'done' | 'dropped';

export interface ExecutorDeps {
  readonly globs: GlobService;
}

export type Executor = (effect: Effect, glob: Glob | null, deps: ExecutorDeps) => Promise<Outcome>;

/** Repository integrations that later slices replace (GitHub App in slice 2, routines in slice 4). */
export interface Provisioner {
  provision(glob: Glob): Promise<{ branch: string; pr: { number: number; headSha: string | null } | null }>;
}

/** Slice 1: no repository integration yet. The branch name is reserved and no PR is opened. */
export const noRepositoryProvisioner: Provisioner = {
  provision: (glob) => Promise.resolve({ branch: glob.id, pr: null }),
};

const MAX_ATTEMPTS = 8;
const POLL_MS = 2_000;

const backoffSeconds = (attempts: number) => Math.min(2 ** attempts * 5, 3_600);

export const defaultExecutors = (provisioner: Provisioner): Partial<Record<EffectKind, Executor>> => ({
  provision: async (_effect, glob, { globs }) => {
    if (glob === null) return 'dropped';
    try {
      const result = await provisioner.provision(glob);
      await globs.applyEvent(glob.id, (g, ctx) => machine.provisioned(g, result, ctx));
      return 'done';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await globs.applyEvent(glob.id, (g, ctx) => machine.provisioningFailed(g, reason, ctx));
      throw error;
    }
  },
});

/**
 * Executes outbox effects with retries. Every effect is re-checked against the glob's current
 * generation first, so work queued before a re-trigger, take over or start again is dropped.
 */
export class OutboxRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private wake = false;

  constructor(
    private readonly db: Db,
    private readonly deps: ExecutorDeps,
    private readonly executors: Partial<Record<EffectKind, Executor>>,
    private readonly log: (task: string, message: string) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.drain(), POLL_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs pending jobs now. Callers that need a result (create_glob) await this. */
  async drain(globId?: string): Promise<void> {
    if (this.running) {
      this.wake = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.wake = false;
        for (;;) {
          const job = await this.claim(globId);
          if (job === null) break;
          await this.execute(job);
        }
      } while (this.wokenDuringDrain());
    } finally {
      this.running = false;
    }
  }

  /** Set by drain() calls that arrive while a drain is running. */
  private wokenDuringDrain(): boolean {
    return this.wake;
  }

  private async claim(globId?: string) {
    // One runner per instance; claim by marking the attempt so a crash mid-job retries later.
    return this.db.transaction(async (t) => {
      const conditions = [eq(schema.outbox.state, 'pending'), lte(schema.outbox.runAfter, new Date())];
      if (globId !== undefined) conditions.push(eq(schema.outbox.globId, globId));
      const [job] = await t
        .select()
        .from(schema.outbox)
        .where(and(...conditions))
        .orderBy(asc(schema.outbox.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (job === undefined) return null;
      await t
        .update(schema.outbox)
        .set({
          attempts: sql`${schema.outbox.attempts} + 1`,
          runAfter: new Date(Date.now() + backoffSeconds(job.attempts) * 1000),
        })
        .where(eq(schema.outbox.id, job.id));
      return job;
    });
  }

  private async execute(job: typeof schema.outbox.$inferSelect): Promise<void> {
    const effect = job.effect;
    const [row] = await this.db
      .select({ data: schema.globs.data })
      .from(schema.globs)
      .where(eq(schema.globs.id, effect.globId));
    const glob = row?.data ?? null;
    const stale =
      effect.kind !== 'delete_glob_data' &&
      (glob === null || ('generation' in effect && effect.generation < glob.generation));

    let state: 'done' | 'dropped' | 'pending' | 'failed';
    let lastError: string | null = null;
    if (stale) {
      state = 'dropped';
    } else {
      const executor = this.executors[effect.kind];
      if (executor === undefined) {
        // Not wired up in this slice; keep it for when the integration exists.
        state = 'dropped';
        lastError = `No executor for ${effect.kind} yet`;
      } else {
        try {
          state = await executor(effect, glob, this.deps);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          state = job.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending';
          this.log(`outbox:${effect.kind}`, `${effect.globId}: ${lastError}`);
        }
      }
    }
    await this.db.update(schema.outbox).set({ state, lastError }).where(eq(schema.outbox.id, job.id));
  }
}
