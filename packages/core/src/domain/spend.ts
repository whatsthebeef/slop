/**
 * USD per million tokens, input then output. Kept by hand (check them against the provider's price list).
 * Claude: Anthropic's pricing page (platform.claude.com/docs/en/about-claude/pricing), checked 2026-10-12.
 * `global.` profiles pay the base price; regional and geographic profiles (`us.`, `eu.`, `apac.`) and
 * in-region IDs carry Anthropic's documented 10% Bedrock premium, so the shorter `anthropic.…` keys hold
 * base + 10% and the longest match picks the `global.` key for global profiles. TO VERIFY against
 * Bedrock's own price table (its Anthropic section didn't render when checked).
 */
export const PRICE_PER_MTOK: Readonly<
  Record<string, { readonly input: number; readonly output: number }>
> = {
  'openai.gpt-oss-120b': { input: 0.15, output: 0.6 },
  'openai.gpt-oss-20b': { input: 0.07, output: 0.3 },
  'anthropic.claude-haiku-4-5': { input: 1.1, output: 5.5 },
  'anthropic.claude-sonnet-5-5': { input: 2.2, output: 11 },
  'anthropic.claude-opus-5-5': { input: 4.4, output: 22 },
  'global.anthropic.claude-haiku-4-5': { input: 1, output: 5 },
  'global.anthropic.claude-sonnet-5-5': { input: 2, output: 10 },
  'global.anthropic.claude-opus-5-5': { input: 4, output: 20 },
};

/**
 * Every source the spend ledger knows. Tagged model calls use all but `review` and `knowledge_page`, whose rows
 * are written by their own services (their calls are untagged, so they aren't counted twice).
 */
export const LLM_SPEND_SOURCES = [
  'review',
  'kb_route',
  'kb_draft',
  'suggest',
  'kb_consolidate',
  'findings',
  'intake',
  'size_check',
  'dependency_inference',
  'search',
  'search_index',
  'decisions',
  'inbox',
  'sub_limit',
  'rollout',
  'chat',
  'knowledge_page',
  'relation_scan',
  'relation_check',
] as const;

export type LlmSpendSource = (typeof LLM_SPEND_SOURCES)[number];

/**
 * What a model call is for, so the server's usage callback can write it to the board's ledger. Embeddings
 * report no usage and aren't counted.
 */
export interface LlmSpendTag {
  readonly boardId: number;
  readonly source: LlmSpendSource;
  readonly globId?: string | null;
}

/** The cost of one call's tokens; null when the model has no price (the tokens are still recorded). */
export const costOf = (model: string, input: number, output: number): number | null => {
  const key = Object.keys(PRICE_PER_MTOK)
    .filter((k) => model.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  const price = key === undefined ? undefined : PRICE_PER_MTOK[key];
  if (price === undefined) return null;
  return (input * price.input + output * price.output) / 1_000_000;
};

/** How far the zone is ahead of UTC at `at`, in milliseconds. */
const zoneOffset = (at: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(at));
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (
    Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) -
    Math.floor(at / 1000) * 1000
  );
};

/** When the month `now` falls in starts in the board's time zone, as a UTC instant, with the month's label (YYYY-MM). */
export const monthStart = (
  now: string,
  timeZone: string,
): { readonly from: string; readonly month: string } => {
  const at = Date.parse(now);
  const local = new Date(at + zoneOffset(at, timeZone));
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const wallStart = Date.UTC(year, month, 1);
  // The offset at the month's start can differ from now's (daylight saving), so settle it from the first guess.
  const first = wallStart - zoneOffset(wallStart, timeZone);
  const from = wallStart - zoneOffset(first, timeZone);
  return {
    from: new Date(from).toISOString(),
    month: `${String(year)}-${String(month + 1).padStart(2, '0')}`,
  };
};

/** What the ledger holds for one board over a period. */
export interface SpendSummary {
  readonly usd: number;
  /** Calls whose model had no price: their tokens are recorded, their cost is not in `usd`. */
  readonly unpricedCalls: number;
  readonly bySource: Readonly<Record<string, number>>;
  /** Unpriced calls per source; a source with none is left out, so a source that lost its price still shows. */
  readonly unpricedBySource: Readonly<Record<string, number>>;
}

/** One LLM call's (or one review's) tokens and cost, as the ledger stores them. */
export interface LlmSpend {
  readonly id: number;
  readonly boardId: number;
  readonly globId: string | null;
  /** What the spend was for, such as `review`. */
  readonly source: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  /** Where to look it up, such as the review artifact's version. */
  readonly ref: string | null;
  readonly createdAt: string;
}

export const emptySpend = (): SpendSummary => ({
  usd: 0,
  unpricedCalls: 0,
  bySource: {},
  unpricedBySource: {},
});

/** Totals the ledger rows (used by the in-memory store; Postgres sums in SQL). */
export const summariseSpend = (rows: readonly LlmSpend[]): SpendSummary => {
  const bySource: Record<string, number> = {};
  const unpricedBySource: Record<string, number> = {};
  let usd = 0;
  let unpricedCalls = 0;
  for (const r of rows) {
    if (r.costUsd === null) {
      unpricedCalls += 1;
      unpricedBySource[r.source] = (unpricedBySource[r.source] ?? 0) + 1;
    } else {
      usd += r.costUsd;
      bySource[r.source] = (bySource[r.source] ?? 0) + r.costUsd;
    }
  }
  return { usd, unpricedCalls, bySource, unpricedBySource };
};
