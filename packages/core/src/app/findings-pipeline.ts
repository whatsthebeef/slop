import {
  coderabbitSeverity,
  coderabbitText,
  FINDING_CLASS_DESCRIPTIONS,
  FINDING_CLASSES,
  FINDING_SEVERITIES,
  FINDING_TEXT_LIMIT,
  fingerprint,
  splitReview,
} from '../domain/findings.js';
import type { FindingClass, FindingSeverity, NewFinding, ReviewFinding, ReviewSource, SplitFinding } from '../domain/findings.js';
import { LLM_WAITING_PREFIX } from '../domain/kb.js';
import type { Clock, Notifier, Store } from '../ports.js';
import { LlmBusy, LlmUnavailable } from './intake-service.js';
import type { Llm } from './intake-service.js';
import { verifiedQuote } from './kb-dedupe.js';
import { LLM_WAIT_MS, MAX_PROCESSING_ATTEMPTS } from './kb-pipeline.js';
import { BusyBackoff, busyMessage, completeWithDeadline } from './llm-call.js';
import { field, isObject, list, parseJson, text } from './llm-json.js';

/** Haiku answers a classification in seconds; a stalled call fails the attempt well inside the lease. */
export const FINDINGS_LLM_TIMEOUT_MS = 30_000;
/** A long free-form review can need thousands of output tokens, so its split gets longer, still inside the lease. */
export const SPLIT_LLM_TIMEOUT_MS = 90_000;
/** How long a claimed source or finding is held before another worker may take it. */
const LEASE_MS = 2 * 60_000;
const backoffMs = (attempts: number) => 30_000 * 2 ** (attempts - 1);
/** A free-form review yields at most this many findings; the rest are dropped. */
export const MAX_FINDINGS_PER_SOURCE = 60;
/** How much of a free-form review the split model sees (the longest stored review is about 26 k). */
export const SPLIT_INPUT_LIMIT = 60_000;
/** Enough for 60 findings of a sentence or two each. */
const SPLIT_MAX_TOKENS = 8_000;
const CLASS_NOTE_LIMIT = 200;

export const SPLIT_SYSTEM = `You extract the distinct problems a code reviewer reported. Include issues that were fixed later; skip checks that passed, praise, plans and status tables.

Respond with one JSON object and nothing else:
{"findings": [{"severity": "in_scope" | "suggestion" | "unknown", "path": string | null, "line": string | null, "quote": string, "text": string}]}
- quote: a phrase copied word for word from the review that states the problem.
- text: the problem in one or two sentences.
- severity: in_scope for a problem the reviewer required fixing, suggestion for an optional improvement, unknown when the review doesn't say.
- path and line: the file and line (or range) the problem is in, when the review names them; otherwise null.
Report each problem once, even if the review repeats it. No problems: {"findings": []}.`;

export const CLASSIFY_SYSTEM = `You classify one finding from a code review into exactly one class.

Classes:
${FINDING_CLASSES.map((c) => `- ${c}: ${FINDING_CLASS_DESCRIPTIONS[c]}`).join('\n')}

Respond with one JSON object and nothing else:
{"class": <one of the class names above>, "note": string}
- note: at most 120 characters on what specifically is wrong. When no class fits, use "other" and say in the note what the class would be.`;

const later = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();

const oneLine = (value: unknown, limit: number): string | null => {
  const line = (text(value)?.trim() ?? '').split(/\r?\n/)[0]?.trim() ?? '';
  return line === '' ? null : line.slice(0, limit);
};

/** A stored path or line from the model: a short single-line string (a number is accepted as a line). */
const location = (value: unknown): string | null => {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : (text(value)?.trim() ?? '');
  return raw === '' || /\s/.test(raw) || raw.length > 500 ? null : raw;
};

/**
 * The split answer: findings whose quote slop finds in the review it showed the model (anything
 * else is dropped, so the model can't invent findings), at most MAX_FINDINGS_PER_SOURCE; null when
 * it isn't usable.
 */
const parseSplit = (answer: string, shown: string): SplitFinding[] | null => {
  const parsed = parseJson(answer);
  if (!isObject(parsed) || !Array.isArray(field(parsed, 'findings'))) return null;
  return list(field(parsed, 'findings'))
    .flatMap((entry): SplitFinding[] => {
      const quote = verifiedQuote(field(entry, 'quote'), shown);
      if (quote === null) return [];
      const severity = FINDING_SEVERITIES.find((s) => s === field(entry, 'severity')) ?? 'unknown';
      const said = text(field(entry, 'text'))?.trim() ?? '';
      return [
        {
          severity,
          round: null,
          path: location(field(entry, 'path')),
          line: location(field(entry, 'line')),
          text: (said === '' ? quote : said).slice(0, FINDING_TEXT_LIMIT),
        },
      ];
    })
    .slice(0, MAX_FINDINGS_PER_SOURCE);
};

/** The classification answer, or why it isn't usable (the attempt fails and is retried). */
const parseClass = (answer: string): { class: FindingClass; note: string | null } | string => {
  const parsed = parseJson(answer);
  const named = text(field(parsed, 'class'))?.trim().toLowerCase() ?? '';
  const found = FINDING_CLASSES.find((c) => c === named);
  if (found === undefined) return named === '' ? 'The class answer was not usable JSON' : `The model answered an unknown class: ${named.slice(0, 80)}`;
  return { class: found, note: oneLine(field(parsed, 'note'), CLASS_NOTE_LIMIT) };
};

const classifyPrompt = (finding: ReviewFinding): string =>
  [
    `Severity: ${finding.severity === 'in_scope' ? 'must fix' : finding.severity === 'suggestion' ? 'suggestion' : 'unknown'}`,
    `File: ${finding.path === null ? '(not given)' : `${finding.path}${finding.line === null ? '' : `:${finding.line}`}`}`,
    'Finding:',
    '<<<',
    finding.text,
    '>>>',
  ].join('\n');

type Outcome<T> = { ok: T } | { failure: string } | { unavailable: LlmUnavailable };

/**
 * The review findings pipeline (spec, self-improvement signals): a background job claims each new
 * review source and splits it into findings (change_reviewer documents by their IN-SCOPE and
 * SUGGESTIONS sections, free-form reviews with one Haiku call whose findings must quote the review,
 * a CodeRabbit comment as one finding), then claims each finding and classifies it with one Haiku
 * call. Claims, deadlines, retries and waiting while the LLM is unavailable follow the KB pipeline.
 */
export class FindingsPipeline {
  private readonly busy = new BusyBackoff();

  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      notifier: Notifier;
      /** Splitting free-form reviews and classifying findings (Haiku). */
      llm: Llm;
      /** Deadline for each classification call; defaults to FINDINGS_LLM_TIMEOUT_MS. */
      llmTimeoutMs?: number;
      /** Deadline for each split call; defaults to SPLIT_LLM_TIMEOUT_MS. */
      splitTimeoutMs?: number;
    },
  ) {}

  /** Splits the oldest due source, else classifies the oldest due finding; returns what it processed, or null when nothing is due. */
  async processNext(): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = this.deps.clock.now();
      const next = await this.deps.store.transaction((tx) => tx.nextReviewSourceToSplit(now));
      if (next === null) break;
      const claimed = await this.claimSource(next.id);
      // Another worker took it first: look for the next one.
      if (claimed === null) continue;
      await this.split(claimed);
      return `source:${claimed.id}`;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = this.deps.clock.now();
      const next = await this.deps.store.transaction((tx) => tx.nextFindingToClassify(now));
      if (next === null) return null;
      const claimed = await this.claimFinding(next.id);
      if (claimed === null) continue;
      await this.classify(claimed);
      return `finding:${claimed.id}`;
    }
    return null;
  }

  /** Takes a pending, due source with a conditional write that holds it for a lease. */
  private async claimSource(id: number): Promise<ReviewSource | null> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const source = await tx.getReviewSource(id);
      if (source?.state !== 'pending' || (source.processAfter !== null && source.processAfter > now)) return null;
      const claimed: ReviewSource = { ...source, processAfter: later(now, LEASE_MS), version: source.version + 1 };
      return (await tx.updateReviewSource(claimed, source.version)) ? claimed : null;
    });
  }

  private async claimFinding(id: number): Promise<ReviewFinding | null> {
    const now = this.deps.clock.now();
    return this.deps.store.transaction(async (tx) => {
      const finding = await tx.getFinding(id);
      if (finding?.state !== 'pending' || (finding.processAfter !== null && finding.processAfter > now)) return null;
      const claimed: ReviewFinding = { ...finding, processAfter: later(now, LEASE_MS), version: finding.version + 1 };
      return (await tx.updateFinding(claimed, finding.version)) ? claimed : null;
    });
  }

  private async split(source: ReviewSource): Promise<void> {
    const content = await this.contentOf(source);
    if (content === null) {
      await this.giveUp(source, 'The review is no longer stored');
      return;
    }
    const found = await this.findingsOf(source, content);
    if ('unavailable' in found) {
      await this.waitSource(source, found.unavailable);
      return;
    }
    if ('failure' in found) {
      await this.failSource(source, found.failure);
      return;
    }
    const now = this.deps.clock.now();
    const findings: NewFinding[] = found.ok.map((f) => ({
      boardId: source.boardId,
      globId: source.globId,
      sourceId: source.id,
      source: source.kind === 'coderabbit_comment' ? 'coderabbit' : 'local_review',
      commitSha: source.commitSha,
      agentSetVersion: source.agentSetVersion,
      ...f,
      fingerprint: fingerprint(f.text),
    }));
    const wrote = await this.deps.store.transaction(async (tx) => {
      const current = await tx.getReviewSource(source.id);
      // Gone (its glob was deleted) or no longer ours: drop the result.
      if (current?.version !== source.version) return false;
      // The source is marked split first, so findings are only written when that write succeeded.
      const marked = await tx.updateReviewSource(
        { ...current, state: 'split', error: null, processAfter: null, version: current.version + 1 },
        current.version,
      );
      if (marked) await tx.insertFindings(findings, now);
      return marked;
    });
    if (wrote) this.deps.notifier.publish({ kind: 'glob.findings', boardId: source.boardId, globId: source.globId });
  }

  /** The text to split: a CodeRabbit comment's own, or the local review artifact's; null when it is gone. */
  private async contentOf(source: ReviewSource): Promise<string | null> {
    if (source.kind === 'coderabbit_comment') return source.content;
    const { artifactId } = source;
    if (artifactId === null) return null;
    const artifact = await this.deps.store.transaction((tx) => tx.getArtifact(artifactId));
    return artifact?.content ?? null;
  }

  /** A source's findings: one for a CodeRabbit comment, a structured review's sections, else the split model's answer. */
  private async findingsOf(source: ReviewSource, content: string): Promise<Outcome<SplitFinding[]>> {
    if (source.kind === 'coderabbit_comment') {
      const body = coderabbitText(content);
      const severity: FindingSeverity = coderabbitSeverity(content);
      return { ok: body === '' ? [] : [{ severity, round: null, path: source.path, line: source.line, text: body }] };
    }
    // A review with no text (a link-only artifact) has nothing to split: no model call.
    if (content.trim() === '') return { ok: [] };
    const structured = splitReview(content);
    if (structured.structured) return { ok: structured.findings };
    const shown = content.slice(0, SPLIT_INPUT_LIMIT);
    try {
      const answer = await completeWithDeadline(
        this.deps.llm,
        { system: SPLIT_SYSTEM, prompt: `Review:\n<<<\n${shown}\n>>>`, maxTokens: SPLIT_MAX_TOKENS },
        this.deps.splitTimeoutMs ?? SPLIT_LLM_TIMEOUT_MS,
      );
      const findings = parseSplit(answer, shown);
      return findings === null ? { failure: 'The split answer was not usable JSON' } : { ok: findings };
    } catch (error) {
      if (error instanceof LlmUnavailable) return { unavailable: error };
      return { failure: error instanceof Error ? error.message : String(error) };
    }
  }

  private async classify(finding: ReviewFinding): Promise<void> {
    let answer: { class: FindingClass; note: string | null } | string;
    try {
      answer = parseClass(
        await completeWithDeadline(
          this.deps.llm,
          { system: CLASSIFY_SYSTEM, prompt: classifyPrompt(finding), maxTokens: 200 },
          this.deps.llmTimeoutMs ?? FINDINGS_LLM_TIMEOUT_MS,
        ),
      );
    } catch (error) {
      if (error instanceof LlmUnavailable) await this.waitFinding(finding, error);
      else await this.failFinding(finding, error instanceof Error ? error.message : String(error));
      return;
    }
    if (typeof answer === 'string') {
      await this.failFinding(finding, answer);
      return;
    }
    const classified = answer;
    const now = this.deps.clock.now();
    const wrote = await this.writeFinding(finding, (current) => ({
      ...current,
      class: classified.class,
      classNote: classified.note,
      state: 'classified',
      classifiedAt: now,
      error: null,
      processAfter: null,
    }));
    if (wrote) this.deps.notifier.publish({ kind: 'glob.findings', boardId: finding.boardId, globId: finding.globId });
  }

  /** A conditional write of a claimed source; false when it changed or went meanwhile. */
  private async writeSource(source: ReviewSource, next: (current: ReviewSource) => ReviewSource): Promise<boolean> {
    return this.deps.store.transaction(async (tx) => {
      const current = await tx.getReviewSource(source.id);
      if (current?.version !== source.version) return false;
      return tx.updateReviewSource({ ...next(current), version: current.version + 1 }, current.version);
    });
  }

  private async writeFinding(finding: ReviewFinding, next: (current: ReviewFinding) => ReviewFinding): Promise<boolean> {
    return this.deps.store.transaction(async (tx) => {
      const current = await tx.getFinding(finding.id);
      if (current?.version !== finding.version) return false;
      return tx.updateFinding({ ...next(current), version: current.version + 1 }, current.version);
    });
  }

  /** A failed split attempt: back off and retry, or mark the source failed after the last attempt. */
  private async failSource(source: ReviewSource, reason: string): Promise<void> {
    const now = this.deps.clock.now();
    const attempts = source.attempts + 1;
    const last = attempts >= MAX_PROCESSING_ATTEMPTS;
    const wrote = await this.writeSource(source, (current) => ({
      ...current,
      attempts,
      error: reason.slice(0, 500),
      state: last ? 'failed' : 'pending',
      processAfter: last ? null : later(now, backoffMs(attempts)),
    }));
    if (wrote && last) this.deps.notifier.publish({ kind: 'glob.findings', boardId: source.boardId, globId: source.globId });
  }

  /** A source that can't be split at all (its review is gone): failed at once, no retries. */
  private async giveUp(source: ReviewSource, reason: string): Promise<void> {
    const wrote = await this.writeSource(source, (current) => ({ ...current, state: 'failed', error: reason, processAfter: null }));
    if (wrote) this.deps.notifier.publish({ kind: 'glob.findings', boardId: source.boardId, globId: source.globId });
  }

  private async failFinding(finding: ReviewFinding, reason: string): Promise<void> {
    const now = this.deps.clock.now();
    const attempts = finding.attempts + 1;
    const last = attempts >= MAX_PROCESSING_ATTEMPTS;
    const wrote = await this.writeFinding(finding, (current) => ({
      ...current,
      attempts,
      error: reason.slice(0, 500),
      state: last ? 'failed' : 'pending',
      processAfter: last ? null : later(now, backoffMs(attempts)),
    }));
    if (wrote && last) this.deps.notifier.publish({ kind: 'glob.findings', boardId: finding.boardId, globId: finding.globId });
  }

  /**
   * Releases a source the LLM couldn't be used for (credentials, model access), to be tried again
   * after LLM_WAIT_MS. Not a failed attempt: only a person can fix it, and sources shouldn't fail meanwhile.
   */
  private async waitSource(source: ReviewSource, unavailable: LlmUnavailable): Promise<void> {
    const wait = this.waitFor(source.id, unavailable);
    await this.writeSource(source, (current) => ({ ...current, error: wait.error, processAfter: wait.processAfter }));
  }

  private async waitFinding(finding: ReviewFinding, unavailable: LlmUnavailable): Promise<void> {
    const wait = this.waitFor(finding.id, unavailable);
    await this.writeFinding(finding, (current) => ({ ...current, error: wait.error, processAfter: wait.processAfter }));
  }

  /** When and why an unusable LLM releases an item: a minute for `LlmUnavailable`, a growing, jittered wait for `LlmBusy`. */
  private waitFor(key: number | string, unavailable: LlmUnavailable): { error: string; processAfter: string } {
    const processAfter = later(this.deps.clock.now(), unavailable instanceof LlmBusy ? this.busy.next(key) : LLM_WAIT_MS);
    const error = unavailable instanceof LlmBusy ? busyMessage(processAfter) : `${LLM_WAITING_PREFIX}${unavailable.reason}`;
    return { error: error.slice(0, 500), processAfter };
  }
}
