import { touchesRolloutPaths, rolloutPrompt, checkRolloutAnswer, ROLLOUT_SYSTEM } from '../domain/rollout.js';
import { writeRolloutEffect } from '../domain/events.js';
import type { EffectOutcome, RetryLater } from '../domain/events.js';
import { LLM_WAITING_PREFIX } from '../domain/kb.js';
import { CAPABILITY_NAMES } from '../domain/capabilities.js';
import type { Board } from '../domain/types.js';
import type { ChangeSource, Clock, Store } from '../ports.js';
import { LlmBusy, LlmUnavailable } from './intake-service.js';
import type { Llm } from './intake-service.js';
import { LLM_TIMEOUT_MS } from './kb-pipeline.js';
import { BusyBackoff, busyMessage, completeWithDeadline } from './llm-call.js';
import { parseJson } from './llm-json.js';
import type { GlobService } from './glob-service.js';

const ANSWER_MAX_TOKENS = 3_000;
const LLM_WAIT_MS = 60_000;

export interface RolloutDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly globs: Pick<GlobService, 'rolloutUnwritten' | 'applyRolloutAnswer' | 'unwrittenRolloutSteps'>;
  readonly changes: ChangeSource;
  readonly llm: Llm;
  readonly model: string;
  /** The merge policy's `rolloutPaths` for a board (undefined: none set, so the defaults apply). */
  readonly rolloutPathsOf: (board: Board) => Promise<readonly string[]>;
  /** Deadline for the model call; defaults to LLM_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/**
 * Writing a merged glob's rollout is the machine's job. When a merge touches the board's rollout paths and the record
 * has no `## Rollout`, one model call reads the diff of those files and the record, and either writes the rollout steps,
 * records "No rollout needed: <reason>", or (only when the diff can't say) adds one specific question for a person.
 */
export class RolloutService {
  private readonly busy = new BusyBackoff();

  constructor(private readonly deps: RolloutDeps) {}

  /** The `write_rollout_steps` job. */
  async run(globId: string, sha: string): Promise<EffectOutcome> {
    if (!(await this.deps.globs.rolloutUnwritten(globId))) return 'dropped';
    const read = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return null;
      const board = await tx.getBoard(glob.boardId);
      if (board === null) return null;
      const record = (await tx.listArtifacts(globId, 'implementation_plan')).find((a) => a.label === '')?.content ?? '';
      return { glob, board, record };
    });
    if (read === null) return 'dropped';
    const { glob, board, record } = read;
    const diff = await this.deps.changes.mergedDiff(board, sha);
    if (diff === null) return 'done';
    const paths = await this.deps.rolloutPathsOf(board);
    const triggering = diff.files.filter((f) => touchesRolloutPaths([f], paths));
    if (triggering.length === 0) {
      // Only a backfill gets here (the merge check queues the job for merges that touch the paths): the narrower
      // defaults no longer ask for a rollout for this one.
      await this.deps.globs.applyRolloutAnswer(globId, { decision: 'none', reason: 'nothing it changed needs a person: the deploy ships it' }, this.deps.model);
      return 'done';
    }
    const patches = Object.fromEntries(triggering.flatMap((f) => (diff.patches?.[f] === undefined ? [] : [[f, diff.patches[f]] as const])));
    let answer: string;
    try {
      answer = await completeWithDeadline(
        this.deps.llm,
        {
          system: ROLLOUT_SYSTEM,
          prompt: rolloutPrompt({ glob: { id: glob.id, title: glob.title }, files: diff.files, patches, record, capabilities: CAPABILITY_NAMES }),
          maxTokens: ANSWER_MAX_TOKENS,
          spend: { boardId: glob.boardId, source: 'rollout', globId: glob.id },
        },
        this.deps.timeoutMs ?? LLM_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof LlmUnavailable) return this.waitFor(globId, error);
      throw error;
    }
    this.busy.clear(globId);
    let parsed: unknown;
    try {
      parsed = parseJson(answer);
    } catch (error) {
      throw new Error(`Unusable rollout answer: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const checked = checkRolloutAnswer(parsed);
    if (!checked.ok) throw new Error(`Unusable rollout answer: ${checked.error}`);
    await this.deps.globs.applyRolloutAnswer(globId, checked.value, this.deps.model);
    return 'done';
  }

  /** Queues the job for every merged glob on the board that still shows "Rollout steps not written"; returns how many were queued. */
  async backfill(boardId: number): Promise<number> {
    const work = await this.deps.globs.unwrittenRolloutSteps(boardId);
    if (work.length === 0) return 0;
    await this.deps.store.transaction((tx) => tx.enqueueEffects(work.map((w) => writeRolloutEffect(w.globId, w.sha))));
    return work.length;
  }

  private waitFor(id: string, unavailable: LlmUnavailable): RetryLater {
    const ms = unavailable instanceof LlmBusy ? this.busy.next(id) : LLM_WAIT_MS;
    const retryAt = new Date(Date.parse(this.deps.clock.now()) + ms).toISOString();
    const reason = (unavailable instanceof LlmBusy ? busyMessage(retryAt) : `${LLM_WAITING_PREFIX}${unavailable.reason}`).slice(0, 500);
    return { state: 'pending', retryAfterMs: ms, reason };
  }
}
