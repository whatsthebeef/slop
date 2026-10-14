import type { Capabilities } from './capabilities.js';
import { CAPABILITY_TEXT, CAPABILITY_NAMES } from './capabilities.js';
import type { Deploy } from './deploys.js';
import type { Glob } from './types.js';

/**
 * Slop's operational state as one chat source ("Slop status (now)"): the facts `/api/health` computes plus the board's own
 * recent failures and deploys. Pure text over plain data. The health part is the server's (it is the same for every board); the
 * board part is read by board, so another board's globs can never appear. Values that look like secrets are redacted.
 */
export const OPS_STATE_MAX_CHARS = 3500;
/** Failures and failed deploys older than this are not "recent". */
export const OPS_RECENT_MS = 24 * 60 * 60 * 1000;
/** A route this slow at p95 (or with any 5xx) in the last hour is worth naming. */
export const OPS_SLOW_P95_MS = 2000;
const MAX_FAILURES = 8;
const MAX_DEPLOYS = 4;
const MAX_ROUTES = 5;
const REASON_CHARS = 160;

export interface OpsIntegration {
  readonly name: string;
  readonly state: string;
  readonly reason: string | null;
  readonly fix: string | null;
  readonly since: string;
}

export interface OpsRoute {
  readonly route: string;
  readonly count: number;
  readonly errors: number;
  readonly p95Ms: number;
}

/** What the server knows about itself, the same for every board. `requests` is admin-only, as on `/api/health`. */
export interface OpsHealth {
  readonly llm: { readonly state: 'unknown' | 'ok' | 'down'; readonly reason?: string; readonly fix?: string; readonly since?: string };
  /** Models answering "busy" often enough to warn of throttling. */
  readonly throttledModels: number;
  readonly integrations: readonly OpsIntegration[];
  readonly capabilities: Capabilities;
  readonly capabilityReasons: Readonly<Record<string, string>>;
  readonly requests?: { readonly routes: readonly OpsRoute[]; readonly outboxBacklog: Readonly<Record<string, number>> | null };
}

const SECRET = /\b(?:bearer\s+\S+|(?:ghp|gho|ghs|ghu|github_pat|xox[a-z]|sk|AKIA|ASIA)[-_A-Za-z0-9]{8,}|[A-Za-z0-9+/_=-]{32,})/gi;
const ASSIGNED = /\b((?:secret|token|password|passwd|api[_-]?key|private[_-]?key|authorization)\w*\s*[=:]\s*)\S+/gi;

/** One line, cut, with anything secret-looking replaced. */
export const safeLine = (s: string, max = REASON_CHARS): string => {
  const first = (s.split('\n')[0] ?? '').trim().replace(ASSIGNED, '$1[redacted]').replace(SECRET, '[redacted]');
  return first.length > max ? `${first.slice(0, max)}...` : first;
};

const time = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

const healthLines = (h: OpsHealth): string[] => {
  const lines: string[] = [];
  const m = h.llm;
  lines.push(
    m.state === 'down'
      ? `AI models: DOWN since ${time(m.since ?? '')}: ${safeLine(m.reason ?? 'unknown reason')}. Fix: ${safeLine(m.fix ?? 'none given')}`
      : m.state === 'ok'
        ? 'AI models: ok'
        : 'AI models: no call yet since the server started, so health is not known',
  );
  if (h.throttledModels > 0) lines.push(`AI models: ${String(h.throttledModels)} model(s) are being throttled by Bedrock (many "busy" answers); answers may be slow or fail until it passes`);
  for (const i of h.integrations) {
    lines.push(
      i.state === 'ok'
        ? `${i.name}: ok`
        : `${i.name}: ${i.state.toUpperCase()} since ${time(i.since)}: ${safeLine(i.reason ?? i.state)}${i.fix === null ? '' : `. Fix: ${safeLine(i.fix)}`}`,
    );
  }
  for (const name of CAPABILITY_NAMES) {
    const on = h.capabilities[name];
    if (on === undefined) continue;
    const why = h.capabilityReasons[name];
    lines.push(on ? `Capability ${name}: on` : `Capability ${name}: OFF (${CAPABILITY_TEXT[name]})${why === undefined ? '' : `. Why: ${safeLine(why)}`}`);
  }
  if (h.requests !== undefined) {
    const slow = h.requests.routes.filter((r) => r.p95Ms > OPS_SLOW_P95_MS || r.errors > 0).slice(0, MAX_ROUTES);
    lines.push(
      slow.length === 0
        ? 'Requests (last hour): no slow routes or server errors'
        : `Requests (last hour), slow or failing routes: ${slow.map((r) => `${safeLine(r.route, 60)} p95 ${String(Math.round(r.p95Ms))} ms, ${String(r.errors)} errors of ${String(r.count)}`).join('; ')}`,
    );
    const backlog = h.requests.outboxBacklog;
    if (backlog !== null) {
      const lanes = Object.entries(backlog).filter(([, n]) => n > 0);
      lines.push(lanes.length === 0 ? 'Outbox backlog: none' : `Outbox backlog (pending jobs): ${lanes.map(([lane, n]) => `${lane} ${String(n)}`).join(', ')}`);
    }
  }
  return lines;
};

interface Failure {
  readonly at: string;
  readonly line: string;
}

/** The board's failures in the last 24 hours, newest first: failed or stalled runs, failed merges, failed provisioning. */
export const recentFailures = (globs: readonly Glob[], now: string): Failure[] => {
  const since = new Date(Date.parse(now) - OPS_RECENT_MS).toISOString();
  const out: Failure[] = [];
  for (const g of globs) {
    const run = g.runs[g.runs.length - 1];
    if (run?.outcome === 'failed' && (run.endedAt ?? run.queuedAt) >= since) {
      out.push({ at: run.endedAt ?? run.queuedAt, line: `${g.id}: run failed${run.purpose === undefined ? '' : ` (${run.purpose})`}: ${safeLine(run.failureReason ?? 'no reason recorded')}` });
    }
    if (g.failure !== null && g.failure.at >= since) {
      const what = g.failure.kind === 'merge' ? 'merge failed' : g.failure.kind === 'provisioning' ? 'provisioning failed' : g.failure.kind === 'needs_pairing' ? 'needs pairing' : 'failed';
      out.push({ at: g.failure.at, line: `${g.id}: ${what}: ${safeLine(g.failure.reason)}` });
    } else if (g.provisioning === 'failed') {
      out.push({ at: g.updatedAt, line: `${g.id}: provisioning failed (the branch or draft PR could not be created)` });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
};

/** Latest deploys first; failed ones from the last day plus whatever is in progress and the newest few. */
const deployLines = (deploys: readonly Deploy[]): string[] =>
  deploys
    .slice(0, MAX_DEPLOYS)
    .map((d) => `${d.globId} to ${d.environment}: ${d.state}${d.error === null ? '' : ` (${safeLine(d.error)})`}, requested ${time(d.requestedAt)}`);

export interface OpsInput {
  readonly health: OpsHealth | null;
  /** Only the asked board's globs and deploys: the caller reads them by board. */
  readonly globs: readonly Glob[];
  readonly deploys: readonly Deploy[];
  readonly now: string;
}

/** The status source's text; always says something, so a healthy system is a finding too. */
export const opsStateText = (input: OpsInput): string => {
  const sections: string[] = [`Slop status as of ${time(input.now)} UTC.`];
  if (input.health === null) sections.push('Slop health: not available from this server.');
  else sections.push(...healthLines(input.health));
  const failures = recentFailures(input.globs, input.now);
  sections.push(
    failures.length === 0
      ? 'Board failures in the last 24 h: none'
      : `Board failures in the last 24 h (${String(failures.length)}):\n${failures.slice(0, MAX_FAILURES).map((f) => `- ${time(f.at)} ${f.line}`).join('\n')}${failures.length > MAX_FAILURES ? `\n(${String(failures.length - MAX_FAILURES)} more not shown)` : ''}`,
  );
  sections.push(input.deploys.length === 0 ? 'Deploys: none on this board' : `Latest deploys:\n${deployLines(input.deploys).map((l) => `- ${l}`).join('\n')}`);
  const text = sections.join('\n');
  return text.length > OPS_STATE_MAX_CHARS ? `${text.slice(0, OPS_STATE_MAX_CHARS - 20)}\n(cut)` : text;
};

const OPERATIONAL =
  /\b(not working|isn'?t working|doesn'?t work|stopped working|broken|down|outage|slow|sluggish|laggy?|timing out|timeout|time out|fail(?:s|ed|ing|ure|ures)?|error(?:s|ing)?|stuck|stalled|hang(?:s|ing)?|unavailable|why (?:isn'?t|hasn'?t|won'?t|can'?t|didn'?t|doesn'?t|is)\b|what'?s wrong|health|status of slop|deploy(?:s|ed|ing|ment)?|integration|backlog|throttl\w*|not (?:start|run|merg|deploy)\w*|isn'?t (?:start|run|merg|deploy)\w*)/i;

/** Whether a question is about something not working (so the status source goes in the prompt). */
export const isOperationalQuestion = (question: string): boolean => OPERATIONAL.test(question);
