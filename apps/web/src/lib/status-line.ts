import { checksExplanation, readyStatus, stuckHint } from '@slop/core';
import type { GlobView } from '@/lib/api';

/** Cut to one line of at most `max` characters. */
const oneLine = (text: string, max = 90): string => {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** A stuck hint's first sentence, without its "Fix: …" advice. */
const firstSentence = (hint: string): string => (hint.split(/\.\s|\s+Fix:/)[0] ?? hint).replace(/\.$/, '');

export interface StatusLine {
  readonly kind: 'base-red' | 'checks' | 'failure' | 'stuck' | 'ready' | 'waiting';
  /** One line for the card. */
  readonly text: string;
  /** The same sentence, uncut, for the glob view. */
  readonly full: string;
  readonly tone: string;
  readonly tip: string;
  /** The failing check run's log, when there is one. */
  readonly url: string | null;
  /** What is being done about it, when known. */
  readonly doing: { readonly text: string; readonly url: string | null } | null;
}

/**
 * The one thing to say about a glob, in plain words, most important first; the rest go in `tip`.
 * Shared by the card and the glob view so the two never disagree.
 */
export const statusLine = (glob: GlobView, now: string): StatusLine | null => {
  const hint = stuckHint(glob, now);
  const checks = checksExplanation(glob);
  const failed = glob.status === 'failed' || glob.failure !== null;
  const reason = glob.failure?.reason ?? 'Routine run failed';
  const session = glob.currentRun?.sessionUrl ?? null;
  const fixing = glob.currentRun?.state === 'watching' ? { text: 'routine session is fixing it', url: session } : null;
  const candidates: StatusLine[] = [];
  if (checks !== null) {
    const details = [checks.text, ...checks.lines.slice(1, 4), checks.url ?? ''].filter((l) => l !== '');
    if (checks.inherited) {
      const head = /^(.*?not this glob's change)/.exec(checks.text)?.[1] ?? "The base branch is red: not this glob's change";
      candidates.push({
        kind: 'base-red',
        text: oneLine(head),
        full: head,
        tone: 'text-required',
        tip: details.join('\n'),
        url: checks.url,
        doing: { text: 'the branch updates when the base is fixed', url: null },
      });
    } else {
      const failure = glob.headChecks?.failure;
      const first = failure?.lines[0];
      const text = failure === undefined ? 'Checks failed' : first === undefined ? `${failure.name} failed` : `${failure.name} failed: ${first}`;
      const full = failure === undefined ? text : `${failure.name} failed${failure.lines.length === 0 ? '' : `: ${failure.lines.slice(0, 3).join(' ')}`}`;
      candidates.push({ kind: 'checks', text: oneLine(text), full, tone: 'text-red', tip: details.join('\n'), url: checks.url, doing: fixing });
    }
  }
  if (failed) {
    const tip = `${reason}${glob.failure?.reason.startsWith('Routine run never started') === true && session !== null ? `\nSession: ${session}` : ''}`;
    candidates.push({ kind: 'failure', text: oneLine(reason), full: reason, tone: 'text-red', tip, url: null, doing: null });
  }
  if (hint !== null) {
    candidates.push({ kind: 'stuck', text: oneLine(firstSentence(hint)), full: firstSentence(hint), tone: 'text-required', tip: hint, url: null, doing: null });
  }
  if (candidates.length === 0) {
    const reviewSha = glob.artifacts?.find((a) => a.kind === 'local_review')?.commitSha ?? null;
    const ready = readyStatus(glob, reviewSha);
    if (ready === null) return null;
    return { ...ready, full: ready.text, tone: ready.kind === 'ready' ? 'text-signal-strong' : 'text-muted-foreground', url: null, doing: null };
  }
  const [top, ...rest] = candidates;
  if (top === undefined) return null;
  const ALSO = { 'base-red': 'the base branch is red', checks: 'checks failed', failure: 'the routine run failed', stuck: 'looks stuck', ready: '', waiting: '' } as const;
  const also = rest.length === 0 ? '' : `\nAlso: ${rest.map((c) => ALSO[c.kind]).join(', ')}`;
  return { ...top, tip: `${top.tip}${also}` };
};
