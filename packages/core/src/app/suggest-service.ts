import { assessmentOf, decisionOf } from '../domain/decision-glob.js';
import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { suggestEffect } from '../domain/events.js';
import type { EffectOutcome, RetryLater } from '../domain/events.js';
import { LLM_WAITING_PREFIX } from '../domain/kb.js';
import { isLearning, learningAssessmentFacts, learningDraft, learningDocument, learningEvidence, learningFacts, learningStatement, learningTarget } from '../domain/learning.js';
import type { LearningRead } from '../domain/learning.js';
import { markdownHeadings, sectionText } from '../domain/sections.js';
import { plainSignal } from '../domain/signals.js';
import {
  checkSuggestion,
  learningPromptFacts,
  overlappingMerges,
  readSuggestion,
  recentOutcomes,
  renderSuggestion,
  siblingLearnings,
  SUGGEST_DRAFT_MAX,
  SUGGEST_PROMPT_VERSION,
  SUGGEST_SECTION_MAX,
  SUGGEST_STATEMENT_MAX,
  SUGGESTION_LABEL,
  suggestionStale,
  suggestPrompt,
  suggestSystem,
} from '../domain/suggestion.js';
import type { StoredSuggestion, SuggestInputs, SuggestionStamp } from '../domain/suggestion.js';
import type { Glob, Role } from '../domain/types.js';
import type { Clock, Notifier, Store, Tx } from '../ports.js';
import { roleOf } from './access.js';
import { addArtifact } from './artifact-service.js';
import { DECISION_SYSTEM_ACTOR } from './decision-glob.js';
import { LlmBusy, LlmUnavailable } from './intake-service.js';
import type { Llm } from './intake-service.js';
import { LLM_TIMEOUT_MS } from './kb-pipeline.js';
import type { KnowledgeService } from './knowledge-service.js';
import { BusyBackoff, busyMessage, completeWithDeadline } from './llm-call.js';
import { parseJson } from './llm-json.js';
import { boardLearnings, readLearning } from './learning-reads.js';
import { SUGGESTION_SCHEMA } from './llm-schemas.js';

/** Who may ask for a suggestion: the people who decide. */
const SUGGESTERS: readonly Role[] = ['admin', 'po'];
const ANSWER_MAX_TOKENS = 8_000;
const LLM_WAIT_MS = 60_000;
/** The merged globs read for overlap: the board's most recent (updated) ones. */
const MERGED_STATUSES = ['reviewing', 'signed_off'] as const;
const SECTION_FALLBACK_MAX = SUGGEST_SECTION_MAX;

/** What the decision section shows: the latest suggestion, whether the draft or target moved since, and whether one is queued. */
export interface SuggestionView {
  readonly suggestion: StoredSuggestion | null;
  readonly stale: boolean;
  readonly pending: boolean;
  /** Why the job waits or gave up (the model is down, an answer could not be used). */
  readonly error: string | null;
}

export interface SuggestDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly notifier: Notifier;
  readonly knowledge: Pick<KnowledgeService, 'previewFor' | 'targetStateFor' | 'signalsToWatch'>;
  readonly llm: Llm;
  readonly model: string;
  /** Deadline for the model call; defaults to LLM_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Suggest on a decision glob: one on-demand model call (never automatic) that reads the learning, its draft, the
 * target's current text, the sibling learnings, the changes merged since and recent outcomes, and recommends approve,
 * approve with an edit, merge into a sibling, or reject. The answer is checked against what the model was given and
 * stored as a new `assessment` artifact version labelled `suggestion`; deciding stays a person's click.
 */
export class SuggestService {
  private readonly busy = new BusyBackoff();

  constructor(private readonly deps: SuggestDeps) {}

  /** Queues a suggestion job (the `llm` lane). Admins and POs ask; a repeat while one waits queues nothing more. */
  async request(email: string, id: string): Promise<Result<{ queued: true }>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<{ queued: true; boardId: number }>> => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      if (decisionOf(glob) === null) return invalidInput(`${id} is not a decision glob`);
      const actor = await roleOf(tx, email, glob.boardId, SUGGESTERS);
      if (!actor.ok) return actor;
      await tx.enqueueEffects([suggestEffect(id)]);
      return ok({ queued: true as const, boardId: glob.boardId });
    });
    if (!result.ok) return result;
    this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: result.value.boardId, globId: id });
    return ok({ queued: true });
  }

  /** The latest suggestion with its staleness and whether a job is queued. Admins and POs read it. */
  async view(email: string, id: string): Promise<Result<SuggestionView>> {
    return this.deps.store.transaction(async (tx): Promise<Result<SuggestionView>> => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      if (decisionOf(glob) === null) return invalidInput(`${id} is not a decision glob`);
      const actor = await roleOf(tx, email, glob.boardId, SUGGESTERS);
      if (!actor.ok) return actor;
      return ok(await this.viewOf(tx, glob));
    });
  }

  private async viewOf(tx: Tx, glob: Glob): Promise<SuggestionView> {
    const latest = (await tx.artifactVersions(glob.id, 'assessment', SUGGESTION_LABEL)).at(-1);
    const suggestion = latest === undefined ? null : readSuggestion(latest.content);
    const [job] = await tx.latestOutboxJobs([glob.id], ['suggest_decision']);
    const learning = isLearning(glob) ? await readLearning(tx, glob.id) : null;
    const stamp = learning === null ? { draftVersion: null, targetVersion: null, promptVersion: SUGGEST_PROMPT_VERSION } : await this.stampOf(tx, learning);
    return {
      suggestion,
      stale: suggestion !== null && suggestionStale(suggestion, stamp),
      pending: job?.state === 'pending',
      error: job !== undefined && (job.state === 'pending' || job.state === 'failed') ? job.lastError : null,
    };
  }

  private async stampOf(tx: Tx, learning: LearningRead): Promise<SuggestionStamp> {
    const state = await this.deps.knowledge.targetStateFor(tx, learning);
    return { draftVersion: learning.artifacts.draft?.version ?? null, targetVersion: state?.version ?? null, promptVersion: SUGGEST_PROMPT_VERSION };
  }

  /** What the model reads, picked and bounded. */
  private async gather(tx: Tx, glob: Glob, learning: LearningRead | null): Promise<{ inputs: SuggestInputs; stamp: SuggestionStamp }> {
    const attributes = decisionOf(glob);
    const flagsOf = (preview: Awaited<ReturnType<KnowledgeService['previewFor']>>) => {
      if (attributes === null) return { suggestedOutcome: null, flags: [] };
      const { suggested, flags } = assessmentOf({ attributes, item: learning === null ? null : learningAssessmentFacts(learning), preview, conflicts: attributes.conflictsWith ?? [] });
      return { suggestedOutcome: suggested, flags };
    };
    const base = { glob: { id: glob.id, title: glob.title } };
    if (learning === null) {
      return { inputs: { ...base, learning: null, siblings: [], merges: [], outcomes: [], flags: flagsOf(null), signals: [] }, stamp: { draftVersion: null, targetVersion: null, promptVersion: SUGGEST_PROMPT_VERSION } };
    }
    // A learning mined from a signal watches that one, and a document proposal watches none: neither gets a check to choose.
    const choosable = learningFacts(glob).signal === null && learningDocument(glob, learning.artifacts) === null;
    const [preview, state, all, merged, watchable] = await Promise.all([
      this.deps.knowledge.previewFor(tx, learning),
      this.deps.knowledge.targetStateFor(tx, learning),
      boardLearnings(tx, glob.boardId),
      tx.listGlobs(glob.boardId, { include: 'work', status: MERGED_STATUSES }),
      choosable ? this.deps.knowledge.signalsToWatch(tx, glob.boardId) : Promise.resolve([]),
    ]);
    const target = learningTarget(glob).routed;
    const draft = learningDraft(learning.artifacts)?.draft ?? null;
    const section = target?.section ?? draft?.section ?? null;
    const text = state?.text ?? null;
    const sectionOnly = text !== null && section !== null ? sectionText(text, section) : null;
    const facts = learningPromptFacts(learning);
    const statement = learningStatement(glob, learning.artifacts);
    const area = [target?.name ?? '', section ?? '', statement];
    const inputs: SuggestInputs = {
      ...base,
      learning: {
        statement: cut(statement, SUGGEST_STATEMENT_MAX),
        type: facts.type,
        evidence: cut(learningEvidence(glob, learning.artifacts), SUGGEST_DRAFT_MAX),
        sourceGlobs: facts.sourceGlobs,
        occurrences: facts.occurrences,
        target,
        draft: draft === null ? null : { section: draft.section, content: cut(draft.content, SUGGEST_DRAFT_MAX) },
        diff: (preview?.diff ?? []).map((l) => (l.op === 'skipped' ? `… ${String(l.count)} unchanged lines` : `${l.op === 'added' ? '+' : l.op === 'removed' ? '-' : ' '} ${l.text}`)),
        targetText: text === null ? null : cut(sectionOnly ?? text, SECTION_FALLBACK_MAX),
        headings: text === null ? [] : markdownHeadings(text).map((h) => `${'#'.repeat(h.level)} ${h.text}`),
      },
      siblings: siblingLearnings(learning, all),
      merges: overlappingMerges(glob, area, merged),
      outcomes: recentOutcomes(learning, all),
      flags: flagsOf(preview),
      signals: watchable.map((g) => ({ key: g.key, text: plainSignal(g) })),
    };
    return { inputs, stamp: { draftVersion: learning.artifacts.draft?.version ?? null, targetVersion: state?.version ?? null, promptVersion: SUGGEST_PROMPT_VERSION } };
  }

  /**
   * The job: asks the model once and stores the checked answer. A model that is down or busy asks to run later without
   * spending an attempt; an answer that can't be used throws, which spends one (three, and the button shows it).
   */
  async run(id: string): Promise<EffectOutcome> {
    const read = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null || decisionOf(glob) === null) return null;
      const learning = isLearning(glob) ? await readLearning(tx, id) : null;
      return { glob, ...(await this.gather(tx, glob, learning)), learning: learning !== null };
    });
    if (read === null) return 'dropped';
    const { glob, inputs, stamp } = read;
    let answer: string;
    try {
      answer = await completeWithDeadline(
        this.deps.llm,
        {
          system: suggestSystem(read.learning),
          schema: SUGGESTION_SCHEMA,
          prompt: suggestPrompt(inputs),
          maxTokens: ANSWER_MAX_TOKENS,
          spend: { boardId: glob.boardId, source: 'suggest', globId: glob.id },
        },
        this.deps.timeoutMs ?? LLM_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof LlmUnavailable) return this.waitFor(glob.id, error);
      throw error;
    }
    this.busy.clear(glob.id);
    const checked = checkSuggestion(parseJson(answer), { siblingIds: inputs.siblings.map((s) => s.id), learning: read.learning, signalKeys: inputs.signals.map((g) => g.key) });
    if (!checked.ok) throw new Error(`Unusable suggestion: ${checked.error.message}`);
    const stored: StoredSuggestion = { suggestion: checked.value, model: this.deps.model, at: this.deps.clock.now(), stamp };
    await this.deps.store.transaction(async (tx) => {
      const current = await tx.getGlob(id);
      if (current === null) return;
      await addArtifact(tx, this.deps.clock, current, DECISION_SYSTEM_ACTOR, {
        kind: 'assessment',
        label: SUGGESTION_LABEL,
        content: renderSuggestion(stored),
        link: null,
        commitSha: null,
        runId: null,
        agentSetVersion: null,
        reviewStats: null,
        by: 'sessionator',
      });
    });
    this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: glob.boardId, globId: glob.id });
    return 'done';
  }

  private waitFor(id: string, unavailable: LlmUnavailable): RetryLater {
    const ms = unavailable instanceof LlmBusy ? this.busy.next(id) : LLM_WAIT_MS;
    const retryAt = new Date(Date.parse(this.deps.clock.now()) + ms).toISOString();
    const reason = (unavailable instanceof LlmBusy ? busyMessage(retryAt) : `${LLM_WAITING_PREFIX}${unavailable.reason}`).slice(0, 500);
    return { state: 'pending', retryAfterMs: ms, reason };
  }
}
