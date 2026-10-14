import type { Capabilities } from './capabilities.js';
import { CAPABILITY_TEXT, CAPABILITY_NAMES } from './capabilities.js';
import type { Deploy } from './deploys.js';
import { STALLED_SOURCE_PREFIX } from './notifications.js';
import type { BoardNotification } from './notifications.js';
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

const URL_CREDENTIALS = /(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g;
/** `token=x`, `GITHUB_TOKEN: x`, `"password":"x"`, `Authorization: Basic x`: the keyword may sit inside a longer name, and the value may be quoted. */
const ASSIGNED = /((?:secret|token|password|passwd|pwd|api[_-]?key|private[_-]?key|authorization|credential)[\w-]*["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|(?:basic|bearer)\s+\S+|\S+)/gi;
/** Well-known token prefixes, case-sensitive so ordinary words such as "skipped_all_checks" are left alone. */
const PREFIXED = /\b(?:(?:gh[pousr]|github_pat|sk)_[-_A-Za-z0-9]{8,}|sk-[-_A-Za-z0-9]{8,}|xox[a-z]-[-A-Za-z0-9]{8,}|(?:AKIA|ASIA)[A-Z0-9]{12,})/g;
const BEARER = /\bbearer\s+\S+/gi;
/** A long unbroken run with letters and digits (a key or hash); paths and plain words have no digits or slashes. */
const BLOB = /\b(?=[A-Za-z0-9+_=-]*\d)(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{32,}/g;

/** One line, cut, with anything secret-looking replaced. */
export const safeLine = (s: string, max = REASON_CHARS): string => {
  const first = (s.split('\n')[0] ?? '')
    .trim()
    .replace(URL_CREDENTIALS, '$1[redacted]@')
    .replace(ASSIGNED, '$1[redacted]')
    .replace(PREFIXED, '[redacted]')
    .replace(BEARER, '[redacted]')
    .replace(BLOB, '[redacted]');
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

/** The newest few deploys, latest first. */
const deployLines = (deploys: readonly Deploy[]): string[] =>
  deploys
    .slice(0, MAX_DEPLOYS)
    .map((d) => `${d.globId} to ${d.environment}: ${d.state}${d.error === null ? '' : ` (${safeLine(d.error)})`}, requested ${time(d.requestedAt)}`);

export interface OpsInput {
  readonly health: OpsHealth | null;
  /** Only the asked board's globs and deploys: the caller reads them by board. */
  readonly globs: readonly Glob[];
  readonly deploys: readonly Deploy[];
  /** The board's active notifications; the stalled ones are listed with the failures. */
  readonly notifications?: readonly BoardNotification[];
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
  const stalled = (input.notifications ?? []).filter((n) => n.source.startsWith(STALLED_SOURCE_PREFIX));
  if (stalled.length > 0) {
    sections.push(`Stalled globs (nobody is moving them):\n${stalled.slice(0, MAX_FAILURES).map((n) => `- ${safeLine(n.title, 100)}: ${safeLine(n.detail)}`).join('\n')}`);
  }
  sections.push(input.deploys.length === 0 ? 'Deploys: none on this board' : `Latest deploys:\n${deployLines(input.deploys).map((l) => `- ${l}`).join('\n')}`);
  const text = sections.join('\n');
  return text.length > OPS_STATE_MAX_CHARS ? `${text.slice(0, OPS_STATE_MAX_CHARS - 20)}\n(cut)` : text;
};

const OPERATIONAL = new RegExp(
  [
    // "isn't working", "won't load", "can't merge", "not starting", "didn't run", "doesn't work"
    String.raw`\b(?:is|are|was|were|does|do|did|has|have|had|will|can|could)(?:n'?t| not)\s+(?:\w+\s+){0,3}(?:work\w*|load\w*|start\w*|run\w*|merg\w*|deploy\w*|sync\w*|respond\w*|answer\w*|finish\w*|appear\w*|show\w*)`,
    String.raw`\b(?:won'?t|can'?t|cannot)\s+(?:\w+\s+){0,3}(?:work|load|start|run|merge|deploy|sync|respond|answer|finish)`,
    String.raw`\bnot (?:working|loading|starting|running|merging|syncing|responding|answering)`,
    String.raw`\b(?:stopped working|broken|outage|timing out|timed out|time out|stuck|stalled|hung|hanging|unavailable|throttl\w*)`,
    String.raw`\b(?:slow|sluggish|laggy)\b`,
    String.raw`\b(?:is|are) (?:slop|the (?:chat|chatbot|app|site|server|board|deploys?|builds?)) (?:down|up|ok|healthy)`,
    String.raw`\b(?:slop|chat|server|the app|the site) (?:is |seems )?down`,
    String.raw`\b(?:deploy|build|merge|run|provisioning|checks?) (?:has |have |just )?(?:failed|fails|failing)`,
    String.raw`\b(?:why|what).{0,30}\b(?:fail(?:ed|ing)?|erroring|errored)`,
    String.raw`\bwhat'?s wrong\b`,
    String.raw`\bsystem (?:status|health)|\bslop(?:'s)? (?:status|health)|\boutbox backlog`,
  ].join('|'),
  'i',
);

/** Whether a question is about something not working (so the status source goes in the prompt). */
export const isOperationalQuestion = (question: string): boolean => OPERATIONAL.test(question);
