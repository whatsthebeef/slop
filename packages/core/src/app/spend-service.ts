import { notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { costOf, monthStart } from '../domain/spend.js';
import type { SpendSummary } from '../domain/spend.js';
import type { Clock, Store } from '../ports.js';

export interface SpendInput {
  readonly boardId: number;
  readonly globId: string | null;
  readonly source: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly ref: string | null;
}

/** What the LLM cost a board so far this month (its time zone's month). */
export interface MonthSpend extends SpendSummary {
  readonly month: string;
}

/** The LLM spend ledger: what each priced piece of work cost, summed per board for the board's spend line. */
export class SpendService {
  constructor(private readonly deps: { readonly store: Store; readonly clock: Clock }) {}

  /** Records one piece of work's tokens and its cost (null when the model has no price: the tokens are still kept). */
  async record(input: SpendInput): Promise<void> {
    if (input.inputTokens === 0 && input.outputTokens === 0) return;
    const costUsd = costOf(input.model, input.inputTokens, input.outputTokens);
    await this.deps.store.transaction((tx) =>
      tx.insertLlmSpend({ ...input, costUsd, createdAt: this.deps.clock.now() }),
    );
  }

  async monthToDate(boardId: number): Promise<Result<MonthSpend>> {
    return this.deps.store.transaction(async (tx) => {
      const board = await tx.getBoard(boardId);
      if (board === null) return notFound(`No board ${boardId}`);
      const now = this.deps.clock.now();
      const { from, month } = monthStart(now, board.timeZone);
      return ok({ month, ...(await tx.sumLlmSpend(boardId, from, now)) });
    });
  }
}
