import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { formatId, parseId } from '../domain/ids.js';
import { decisionGroup } from '../domain/group.js';
import * as machine from '../domain/machine.js';
import type { Context, Transition } from '../domain/machine.js';
import { assessmentOf, decisionOf, decisionGlobTitle, extractedKey, inboxKey, replacementOf } from '../domain/decision-glob.js';
import type { LearningAssessmentFacts } from '../domain/decision-glob.js';
import type { DecisionAttributes, DecisionChannel, DecisionScope } from '../domain/attributes.js';
import { isSuperseded } from '../domain/decisions.js';
import type { Decision } from '../domain/decisions.js';
import { INBOX_EXCERPT_CHARS, inboxLink, inboxTitle } from '../domain/inbox.js';
import type { InboxItem } from '../domain/inbox.js';
import type { DraftPreview } from '../domain/kb.js';
import type { Provenance } from '../domain/knowledge.js';
import { isHumanCategory } from '../domain/types.js';
import type { Actor, Glob } from '../domain/types.js';
import type { Clock, Hint, Tx } from '../ports.js';
import { RULES_MODEL, readSuggestion, renderSuggestion, rulesSuggestion, SUGGESTION_LABEL } from '../domain/suggestion.js';
import { addArtifact } from './artifact-service.js';

/** The name slop's own writes carry (mined proposals, assessments, the backfill). */
export const DECISION_SYSTEM_ACTOR = 'slop';

/** How many times a glob write retries when a person moved the glob between the read and the write. */
const WRITE_RETRIES = 3;

export interface DecisionDeps {
  readonly clock: Clock;
}

/** The context of a system step on a decision (no actor, no runs), at `at` when a past date is being recorded. */
export const decisionContext = (clock: Clock, actor: Actor | null, at?: string): Context => ({
  actor,
  now: at ?? clock.now(),
  // A decision never starts a routine run.
  newRunId: () => {
    throw new Error('A decision never starts a run');
  },
  routineOwnerFor: () => '',
});

/** How an artifact's provenance reads per channel: an agent's run, slop's own mining or backfill, or a person. */
const planBy = (channel: DecisionChannel): Provenance['by'] =>
  channel === 'agent' ? 'routine' : channel === 'mined' ? 'sessionator' : channel === 'migration' ? 'backfill' : 'human';

export interface NewDecisionGlob {
  readonly boardId: number;
  /** The person creating it, or the synthetic actor of a system channel. */
  readonly actor: Actor;
  readonly title: string;
  /** plan.md v1: the proposal text (statement and evidence, Markdown). */
  readonly payload: string;
  readonly attributes: DecisionAttributes;
  /** An explicit `k` ID on the board (checked); left out, the glob takes the next `k` number. */
  readonly id?: string;
  /** Makes creation idempotent: `inbox:<id>`, `decision:<id>` (a learning's glob has `kb:<id>`). */
  readonly creationKey: string;
  readonly group?: string | null;
  /** Backdates the glob's creation (the backfill keeps the original date). */
  readonly at?: string;
  /** Write the deterministic assessment now (automated channels); a human channel asks for it on demand. */
  readonly assess?: { readonly item: LearningAssessmentFacts | null };
}

export interface CreatedDecision {
  readonly glob: Glob;
  /** False when the creation key already had a glob. */
  readonly created: boolean;
  /** What to publish after the transaction commits. */
  readonly hints: readonly Hint[];
}

/**
 * Creates a decision glob inside the caller's transaction: the KB flows already run in one, and a decision needs none of
 * `GlobService.create` (no embedder, size check, merge-policy hold or intake snapshot). Idempotent on `creationKey`.
 */
export const createDecisionInTx = async (tx: Tx, deps: DecisionDeps, input: NewDecisionGlob): Promise<Result<CreatedDecision>> => {
  const existing = await tx.findGlobByCreationKey(input.boardId, input.creationKey);
  if (existing !== null) return ok({ glob: existing, created: false, hints: [] });
  const board = await tx.getBoard(input.boardId);
  if (board === null) return notFound(`No board ${String(input.boardId)}`);
  const { scope } = input.attributes;
  let scopedGroup: string | null = null;
  if (scope.kind === 'glob') {
    const governed = await tx.getGlob(scope.ref);
    if (governed?.boardId !== input.boardId || isHumanCategory(governed.category)) return invalidInput(`No work glob ${scope.ref} on board ${String(input.boardId)}`);
    scopedGroup = governed.group;
  }
  const clock: Clock = input.at === undefined ? deps.clock : { now: () => input.at ?? '' };
  if (input.id !== undefined) {
    const parsed = parseId(input.id);
    if (parsed?.letter !== 'k' || parsed.boardId !== board.id) return invalidInput(`${input.id} is not a decision ID on board ${String(board.id)}`);
  }
  const id = input.id ?? formatId(board.id, 'k', await tx.nextNumber(board.id, 'k'));
  const transition = machine.create(
    {
      id,
      boardId: board.id,
      title: input.title,
      type: null,
      category: 'decision',
      attributes: input.attributes,
      group: input.group ?? decisionGroup(input.attributes, scopedGroup),
      environment: null,
      autoTrigger: false,
    },
    board,
    decisionContext(clock, input.actor),
  );
  if (!transition.ok) return transition;
  const glob = { ...transition.value.glob, version: 1 };
  if (!(await tx.insertGlob(glob, input.creationKey))) throw new Error(`Glob ID collision for ${glob.id}`);
  await tx.appendEvents(transition.value.events);
  await addArtifact(tx, clock, glob, input.actor.email, {
    kind: 'plan',
    label: '',
    content: input.payload,
    link: null,
    commitSha: null,
    runId: null,
    agentSetVersion: null,
    reviewStats: null,
    by: planBy(input.attributes.channel),
  });
  const hints: Hint[] = [{ kind: 'glob.changed', boardId: glob.boardId, globId: glob.id, version: glob.version }];
  if (input.assess !== undefined) {
    const assessed = await writeAssessment(tx, deps, glob, input.assess.item, null);
    const leaned = input.assess.item === null ? false : await writeLeaning(tx, deps, glob, input.assess.item, null, null);
    if (assessed || leaned) hints.push({ kind: 'glob.artifacts', boardId: glob.boardId, globId: glob.id });
  }
  return ok({ glob, created: true, hints });
};

/** What a person may set when promoting an inbox item: a title and statement of their own, and a scope. */
export interface PromoteInput {
  readonly title?: string | undefined;
  readonly statement?: string | undefined;
  readonly scope?: DecisionScope | undefined;
}

/**
 * Creates the decision glob for an inbox item a person promotes (creation key `inbox:<id>`): the item's summary and
 * excerpt are the proposal text. It has no knowledge item, so accepting it records the outcome only.
 */
export const createDecisionForInbox = async (
  tx: Tx,
  deps: DecisionDeps,
  item: InboxItem,
  actor: Actor,
  input: PromoteInput,
): Promise<Result<CreatedDecision>> => {
  const heading = input.title?.trim() ?? '';
  const title = heading === '' ? inboxTitle(item) : heading;
  const statement = input.statement?.trim() || item.summary?.trim() || title;
  const excerpt = item.text.trim().slice(0, INBOX_EXCERPT_CHARS);
  return createDecisionInTx(tx, deps, {
    boardId: item.boardId,
    actor,
    title: decisionGlobTitle(title),
    payload: `${statement}\n\n## Source\n\n${inboxTitle(item)} (${inboxLink(item.boardId, item.id)})\n\n> ${excerpt.replace(/\n/g, '\n> ')}\n`,
    attributes: {
      scope: input.scope ?? { kind: 'future_work', ref: null },
      origin: { kind: 'inbox', id: item.id },
      channel: 'inbox',
      outcome: null,
    },
    creationKey: inboxKey(item.id),
  });
};

/**
 * Creates the decision glob for a decision extracted from a glob's record or an inbox item (creation key
 * `decision:<id>`), when a person promotes it. It governs the glob it was taken on, else the whole project.
 */
export const createDecisionForExtracted = async (
  tx: Tx,
  deps: DecisionDeps,
  decision: Decision,
  actor: Actor,
  channel: 'human' | 'migration',
  at?: string,
): Promise<Result<CreatedDecision>> =>
  createDecisionInTx(tx, deps, {
    boardId: decision.boardId,
    actor,
    title: decisionGlobTitle(decision.statement),
    payload: `${decision.statement.trim()}\n\n## Source\n\n${decision.sourceLabel}\n\n> ${decision.quote.replace(/\n/g, '\n> ')}\n`,
    attributes: {
      scope: decision.globId === null ? { kind: 'project', ref: null } : { kind: 'glob', ref: decision.globId },
      origin: { kind: 'extracted', decisionId: decision.id },
      channel,
      outcome: null,
    },
    creationKey: extractedKey(decision.id),
    group: decision.group,
    ...(at === undefined ? {} : { at }),
  });

/**
 * Writes the deterministic assessment as a new `assessment` artifact version when its text changed; false when the glob
 * already has this text. `preview` is the draft's diff when the caller has it.
 */
export const writeAssessment = async (
  tx: Tx,
  deps: DecisionDeps,
  glob: Glob,
  item: LearningAssessmentFacts | null,
  preview: DraftPreview | null,
): Promise<boolean> => {
  const attributes = decisionOf(glob);
  if (attributes === null) return false;
  const { markdown } = assessmentOf({ attributes, item, preview, conflicts: attributes.conflictsWith ?? [] });
  const latest = (await tx.artifactVersions(glob.id, 'assessment', '')).at(-1);
  if (latest?.content === markdown) return false;
  await addArtifact(tx, deps.clock, glob, DECISION_SYSTEM_ACTOR, {
    kind: 'assessment',
    label: '',
    content: markdown,
    link: null,
    commitSha: null,
    runId: null,
    agentSetVersion: null,
    reviewStats: null,
    by: 'sessionator',
  });
  return true;
};

/**
 * Writes the rules' recommendation (`rulesSuggestion`) as a new `suggestion` artifact version, unless the latest one is
 * already current: a model's for this draft, or the rules' own with nothing changed. So the latest recommendation never
 * predates the draft. False when nothing was written.
 */
export const writeLeaning = async (
  tx: Tx,
  deps: DecisionDeps,
  glob: Glob,
  item: LearningAssessmentFacts | null,
  preview: DraftPreview | null,
  draftVersion: number | null,
): Promise<boolean> => {
  const attributes = decisionOf(glob);
  if (attributes === null) return false;
  const stored = rulesSuggestion({ attributes, item, preview, conflicts: attributes.conflictsWith ?? [] }, draftVersion, deps.clock.now());
  const latest = (await tx.artifactVersions(glob.id, 'assessment', SUGGESTION_LABEL)).at(-1);
  const current = latest === undefined ? null : readSuggestion(latest.content);
  if (current !== null) {
    if (current.model !== RULES_MODEL && current.stamp.draftVersion === draftVersion) return false;
    if (current.model === RULES_MODEL && current.stamp.draftVersion === draftVersion && JSON.stringify(current.suggestion) === JSON.stringify(stored.suggestion)) return false;
  }
  await addArtifact(tx, deps.clock, glob, DECISION_SYSTEM_ACTOR, {
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
  return true;
};

/**
 * Applies a pure step to the stored glob as a version-checked write, re-reading and trying again when a person changed
 * the glob in between (a system step carries no client version). Returns the glob after the step, and whether it changed.
 */
export const applyDecisionStep = async (
  tx: Tx,
  id: string,
  step: (glob: Glob) => Result<Transition>,
): Promise<Result<{ glob: Glob; changed: boolean }>> => {
  for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
    const glob = await tx.getGlob(id);
    if (glob === null) return notFound(`No glob ${id}`);
    const transition = step(glob);
    if (!transition.ok) return transition;
    const { changed, events, effects } = transition.value;
    if (!changed) {
      await tx.appendEvents(events);
      await tx.enqueueEffects(effects);
      return ok({ glob, changed: false });
    }
    const next = { ...transition.value.glob, version: glob.version + 1 };
    if (await tx.updateGlob(next, glob.version)) {
      await tx.appendEvents(events);
      await tx.enqueueEffects(effects);
      return ok({ glob: next, changed: true });
    }
  }
  throw new Error(`Could not update decision ${id} after ${String(WRITE_RETRIES)} tries`);
};

const RETIRED_REASON = 'Replacement cards retired';

/** Whether the older choice still has this proposal waiting for a person: neither choice was replaced, deleted or decided since. */
export const replacementOpen = (old: Decision | undefined, next: Decision | undefined): old is Decision & { replacedBy: number } =>
  old !== undefined && next !== undefined && old.replaceState === 'hint' && old.replacedBy === next.id && !isSuperseded(old) && !isSuperseded(next);

/**
 * Closes the open replacement cards of a board whose pair is no longer waiting (a choice was replaced or deleted, or the
 * proposal was answered elsewhere). `all` is the board's choices as they are now. Returns the hints to publish.
 */
export const closeStaleReplacements = async (tx: Tx, deps: DecisionDeps, boardId: number, all: readonly Decision[]): Promise<Hint[]> => {
  const byId = new Map(all.map((d) => [d.id, d]));
  const hints: Hint[] = [];
  const cards = await tx.listGlobs(boardId, { include: 'decisions', origins: ['replacement'], status: ['planning', 'in_progress'] });
  for (const card of cards) {
    const pair = replacementOf(card);
    if (pair === null || replacementOpen(byId.get(pair.oldId), byId.get(pair.newId))) continue;
    const closed = await applyDecisionStep(tx, card.id, (glob) => machine.closeReplacement(glob, decisionContext(deps.clock, null)));
    if (closed.ok && closed.value.changed) hints.push({ kind: 'glob.changed', boardId, globId: card.id, version: closed.value.glob.version });
  }
  return hints;
};

/**
 * Retires the replacement cards of a board: slop no longer asks a person about a replacement it can't verify. Every open
 * card is closed ("Replacement cards retired") and every choice still carrying a proposal (`hint`) stands again. A repeat
 * finds nothing to do. Returns the hints to publish.
 */
export const retireReplacementCards = async (tx: Tx, deps: DecisionDeps, boardId: number, all: readonly Decision[]): Promise<Hint[]> => {
  const hints: Hint[] = [];
  for (const d of all) {
    if (d.replaceState !== 'hint') continue;
    await tx.updateDecision(d.id, { replacedBy: null, replaceState: null, replaceOldQuote: null, replaceNewQuote: null, replaceReason: null });
  }
  const cards = await tx.listGlobs(boardId, { include: 'decisions', origins: ['replacement'], status: ['planning', 'in_progress'] });
  for (const card of cards) {
    const closed = await applyDecisionStep(tx, card.id, (glob) => machine.closeReplacement(glob, decisionContext(deps.clock, null), RETIRED_REASON));
    if (closed.ok && closed.value.changed) hints.push({ kind: 'glob.changed', boardId, globId: card.id, version: closed.value.glob.version });
  }
  return hints;
};
