import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

/** A request taking longer than this is logged with its timings (CloudFront gives up on the origin at 60 s, Cloudflare at 100 s). */
export const SLOW_REQUEST_MS = 2_000;
/** Answered with a 503 and a reason instead of leaving the proxy to time out. Below CloudFront's 60 s origin read timeout. */
export const REQUEST_TIMEOUT_MS = 55_000;
/** The window the health summary covers. */
const WINDOW_MS = 60 * 60_000;
/** Samples kept per route, so a busy route can't grow without bound. */
const MAX_SAMPLES_PER_ROUTE = 2_000;
/** Distinct routes kept: a bound on memory whatever the clients send. */
const MAX_ROUTES = 300;

interface RequestStats {
  dbMs: number;
  llmMs: number;
  /** What the request is called in the summary: the route pattern, or `mcp <tool>` for an MCP call. */
  label: string | null;
}

interface Sample {
  readonly at: number;
  readonly ms: number;
  readonly status: number;
}

export interface RouteSummary {
  readonly route: string;
  readonly count: number;
  readonly errors: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

export interface MetricsSummary {
  readonly windowMinutes: number;
  readonly inFlightRequests: number;
  readonly dbTransactionsOpen: number;
  readonly llmCallsInFlight: number;
  readonly eventLoopLagMs: { readonly mean: number; readonly p99: number; readonly max: number };
  readonly routes: readonly RouteSummary[];
}

const percentile = (sorted: readonly number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

/**
 * What the server measures about its own requests: per-route latency over the last hour, the time each request spends in the
 * database and in model calls, and the gauges that show where a slow request waits. In memory only; a restart starts it over.
 */
export class RequestMetrics {
  private readonly stats = new AsyncLocalStorage<RequestStats>();
  private readonly samples = new Map<string, Sample[]>();
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private inFlight = 0;
  private dbOpen = 0;
  private llmOpen = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.loop.enable();
  }

  /** Runs `work` as one request: what it spends in `db()` and `llm()` is added up for it. */
  run<T>(work: (stats: RequestStats) => Promise<T>): Promise<T> {
    const stats: RequestStats = { dbMs: 0, llmMs: 0, label: null };
    this.inFlight++;
    return this.stats.run(stats, () => work(stats)).finally(() => this.inFlight--);
  }

  /** Names the current request (an MCP call is one URL for every tool). */
  label(name: string): void {
    const current = this.stats.getStore();
    if (current !== undefined) current.label = name;
  }

  /** Times a database transaction, queueing for a connection included. */
  db<T>(work: () => Promise<T>): Promise<T> {
    this.dbOpen++;
    return this.timed('dbMs', work).finally(() => this.dbOpen--);
  }

  /** Times a model call. */
  llm<T>(work: () => Promise<T>): Promise<T> {
    this.llmOpen++;
    return this.timed('llmMs', work).finally(() => this.llmOpen--);
  }

  private async timed<T>(field: 'dbMs' | 'llmMs', work: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await work();
    } finally {
      const current = this.stats.getStore();
      if (current !== undefined) current[field] += this.now() - started;
    }
  }

  record(route: string, ms: number, status: number): void {
    const at = this.now();
    if (!this.samples.has(route) && this.samples.size >= MAX_ROUTES) return;
    const list = this.samples.get(route) ?? [];
    list.push({ at, ms, status });
    if (list.length > MAX_SAMPLES_PER_ROUTE) list.splice(0, list.length - MAX_SAMPLES_PER_ROUTE);
    this.samples.set(route, list);
  }

  summary(): MetricsSummary {
    const since = this.now() - WINDOW_MS;
    const routes: RouteSummary[] = [];
    for (const [route, all] of this.samples) {
      const live = all.filter((s) => s.at >= since);
      if (live.length === 0) {
        this.samples.delete(route);
        continue;
      }
      if (live.length !== all.length) this.samples.set(route, live);
      const sorted = live.map((s) => s.ms).sort((a, b) => a - b);
      routes.push({
        route,
        count: live.length,
        errors: live.filter((s) => s.status >= 500).length,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        maxMs: sorted.at(-1) ?? 0,
      });
    }
    routes.sort((a, b) => b.p95Ms - a.p95Ms);
    const ms = (ns: number) => Math.round(ns / 1e4) / 100;
    return {
      windowMinutes: WINDOW_MS / 60_000,
      inFlightRequests: this.inFlight,
      dbTransactionsOpen: this.dbOpen,
      llmCallsInFlight: this.llmOpen,
      eventLoopLagMs: { mean: ms(this.loop.mean), p99: ms(this.loop.percentile(99)), max: ms(this.loop.max) },
      routes,
    };
  }

  /** Resets the event-loop histogram, so each health read shows the lag since the last one. */
  resetLoop(): void {
    this.loop.reset();
  }
}

/** The shared instance: the store and the model adapters report into it without being handed one. */
export const requestMetrics = new RequestMetrics();

/** Numbers and path shapes only; no query string, no names, so a log line can't carry a secret. */
const shapeOf = (path: string): string => path.replace(/\/[0-9a-f-]{16,}(?=\/|$)/gi, '/:id').replace(/\/\d+(?=\/|$)/g, '/:n');

const bytesOf = async (res: Response): Promise<number | null> => {
  const length = res.headers.get('content-length');
  if (length !== null) return Number(length);
  if (res.body === null) return 0;
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return null;
  return (await res.clone().arrayBuffer()).byteLength;
};

const streams = (c: Context): boolean => c.req.header('accept')?.includes('text/event-stream') === true && c.req.method === 'GET';

interface TimingOptions {
  readonly metrics?: RequestMetrics;
  readonly slowMs?: number;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
}

/**
 * Times every request. A slow one is logged as one JSON line (route, method, status, duration, database and model time,
 * response bytes). One that is still running at the timeout is answered with a 503 and a reason, so a failure is fast and
 * visible instead of a proxy's 502/504; its work carries on in the background. Event streams are not timed out.
 */
export const requestTiming =
  ({ metrics = requestMetrics, slowMs = SLOW_REQUEST_MS, timeoutMs = REQUEST_TIMEOUT_MS, log = (line) => console.log(line) }: TimingOptions = {}): MiddlewareHandler =>
  async (c, next) => {
    const started = Date.now();
    const stream = streams(c);
    return metrics.run(async (stats) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const work = next().then(() => 'done' as const);
      // A request still running at the timeout may fail later; that must not become an unhandled rejection.
      work.catch(() => undefined);
      const outcome = await Promise.race([
        work,
        new Promise<'timeout'>((resolve) => {
          if (!stream) timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      let response: Response | undefined;
      if (outcome === 'timeout') {
        timedOut = true;
        response = c.json({ code: 'timeout', message: `The request took longer than ${Math.round(timeoutMs / 1000)} s and was stopped waiting; it may still finish, so check before retrying a write` }, 503);
      }
      const status = response?.status ?? c.res.status;
      const ms = Date.now() - started;
      const matched = routePath(c, -1);
      // A path no route matched gets one fixed label: random URLs must not add keys (memory) or put their text in the log.
      const unmatched = matched === '/*' || matched === '*';
      const route = stats.label ?? `${c.req.method} ${unmatched ? '<unmatched>' : matched}`;
      if (!stream) metrics.record(route, ms, status);
      if (ms >= slowMs || timedOut) {
        const bytes = timedOut || stream ? null : await bytesOf(c.res);
        log(JSON.stringify({ slowRequest: true, route, method: c.req.method, path: unmatched ? null : shapeOf(c.req.path), status, ms, dbMs: stats.dbMs, llmMs: stats.llmMs, bytes, timedOut }));
      }
      return response;
    });
  };
