import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { formatId, parseId } from '../domain/ids.js';
import * as machine from '../domain/machine.js';
import type { Context, Transition } from '../domain/machine.js';
import { assessmentOf, broaderConflicts, decisionOf, decisionGlobTitle, defaultScope, extractedKey, inboxKey, kbItemKey, proposalText } from '../domain/decision-glob.js';
import type { DecisionAttributes, DecisionChannel, DecisionScope } from '../domain/attributes.js';
import type { Decision } from '../domain/decisions.js';
import { INBOX_EXCERPT_CHARS, inboxLink, inboxTitle } from '../domain/inbox.js';
import type { InboxItem } from '../domain/inbox.js';
import type { DraftPreview, KbItem } from '../domain/kb.js';
import type { Provenance } from '../domain/knowledge.js';
import type { Actor, Glob } from '../domain/types.js';
import type { Clock, Hint, Tx } from '../ports.js';
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
  /** The statement: becomes the glob's summary. */
  readonly summary: string;
  /** plan.md v1: the proposal text (statement and evidence, Markdown). */
  readonly payload: string;
  readonly attributes: DecisionAttributes;
  /**
   * The glob's ID when it fronts a KB item: the item's own `k` ID (items and decision globs share the board's `k`
   * sequence). Left out, the glob takes the next `k` number.
   */
  readonly id?: string;
  /** Makes creation idempotent: `kb:<item>`, `inbox:<id>`, `decision:<id>`. */
  readonly creationKey: string;
  readonly group?: string | null;
  /** Backdates the glob's creation (the backfill keeps the original date). */
  readonly at?: string;
  /** Write the deterministic assessment now (automated channels); a human channel asks for it on demand. */
  readonly assess?: { readonly item: KbItem | null };
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
  if (scope.kind === 'glob') {
    const governed = await tx.getGlob(scope.ref);
    if (governed?.boardId !== input.boardId || governed.category === 'decision') return invalidInput(`No work glob ${scope.ref} on board ${String(input.boardId)}`);
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
      summary: input.summary,
      type: 'same',
      category: 'decision',
      attributes: input.attributes,
      group: input.group ?? null,
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
  if (input.assess !== undefined && (await writeAssessment(tx, deps, glob, input.assess.item, null))) {
    hints.push({ kind: 'glob.artifacts', boardId: glob.boardId, globId: glob.id });
  }
  return ok({ glob, created: true, hints });
};

/**
 * Creates the decision glob that fronts a new KB item (before the item is inserted: the caller stores the glob's ID on
 * it). An agent's submission, a mined signal or an effect check's revision all come through here.
 */
export const createDecisionForItem = async (
  tx: Tx,
  deps: DecisionDeps,
  item: KbItem,
  actor: Actor,
  channel: 'agent' | 'mined',
): Promise<Result<CreatedDecision>> =>
  createDecisionInTx(tx, deps, {
    boardId: item.boardId,
    actor,
    title: decisionGlobTitle(item.statement),
    summary: item.statement,
    payload: proposalText(item),
    attributes: { scope: defaultScope(item.type), origin: { kind: 'kb_item', id: item.id }, channel, kbItemId: item.id, outcome: null },
    id: item.id,
    creationKey: kbItemKey(item.id),
    at: item.createdAt,
    assess: { item },
  });

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
    summary: statement,
    payload: `${statement}\n\n## Source\n\n${inboxTitle(item)} (${inboxLink(item.boardId, item.id)})\n\n> ${excerpt.replace(/\n/g, '\n> ')}\n`,
    attributes: {
      scope: input.scope ?? { kind: 'future_work', ref: null },
      origin: { kind: 'inbox', id: item.id },
      channel: 'inbox',
      kbItemId: null,
      outcome: null,
    },
    creationKey: inboxKey(item.id),
  });
};

/**
 * Creates the decision glob for a decision extracted from a glob's record or an inbox item (creation key
 * `decision:<id>`): a person promoting it (`human`) or the backfill (`migration`, backdated to the decision's date).
 * It governs the glob it was taken on, else the whole project.
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
    summary: decision.statement,
    payload: `${decision.statement.trim()}\n\n## Source\n\n${decision.sourceLabel}\n\n> ${decision.quote.replace(/\n/g, '\n> ')}\n`,
    attributes: {
      scope: decision.globId === null ? { kind: 'project', ref: null } : { kind: 'glob', ref: decision.globId },
      origin: { kind: 'extracted', decisionId: decision.id },
      channel,
      kbItemId: null,
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
  item: KbItem | null,
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

/** The decision glob in front of a KB item: by the item's link, else by the creation key a backfill or retry left. */
const globOfItem = async (tx: Tx, item: KbItem): Promise<Glob | null> => {
  const linked = item.decisionGlobId === undefined || item.decisionGlobId === null ? null : await tx.getGlob(item.decisionGlobId);
  return linked ?? (await tx.findGlobByCreationKey(item.boardId, kbItemKey(item.id)));
};

/** Recomputes which broader decisions the open item contradicts (by scope rank) and records the change. */
const refreshConflicts = async (tx: Tx, clock: Clock, item: KbItem, glob: Glob): Promise<boolean> => {
  const attributes = decisionOf(glob);
  if (attributes === null) return false;
  const globs = new Map<string, Glob>();
  for (const c of item.contradicts) {
    if (c.kind !== 'item') continue;
    const other = await tx.getKbItem(c.ref);
    const otherGlob = other === null ? null : await globOfItem(tx, other);
    if (otherGlob !== null) globs.set(c.ref, otherGlob);
  }
  const ids = broaderConflicts(attributes.scope, item, (itemId) => globs.get(itemId));
  const result = await applyDecisionStep(tx, glob.id, (current) => machine.decisionConflicts(current, ids, decisionContext(clock, null)));
  return result.ok && result.value.changed;
};

/** Channels whose assessments slop writes by itself as the pipeline works; a person's pasted notes are assessed on demand. */
const AUTOMATED: readonly DecisionChannel[] = ['agent', 'mined'];

/**
 * Brings the decision glob in front of a KB item in line with the item (the single entry point for the sync): an
 * open item reopens a closed glob and refreshes its conflict flags and assessment; an approved item accepts it, a rejected
 * one rejects it, one the pipeline closed (merged, suppressed, covered) archives it. Runs in the caller's transaction,
 * right after the item's own write, and returns what to publish after the commit. Nothing happens for an item without a glob.
 */
export const syncDecisionFromItem = async (tx: Tx, clock: Clock, item: KbItem, preview: DraftPreview | null = null): Promise<Hint[]> => {
  const found = await globOfItem(tx, item);
  if (found === null || decisionOf(found) === null) return [];
  const hints: Hint[] = [];
  const changed = (glob: Glob) => hints.push({ kind: 'glob.changed', boardId: glob.boardId, globId: glob.id, version: glob.version });
  const by = item.decidedBy ?? DECISION_SYSTEM_ACTOR;
  const ctx = (): Context => decisionContext(clock, null);
  const step = await applyDecisionStep(tx, found.id, (glob) => {
    switch (item.status) {
      case 'open':
        return machine.decisionReopened(glob, ctx());
      case 'approved':
        return machine.decisionApproved(glob, { by }, ctx());
      case 'rejected':
        return machine.decisionRejected(glob, { by, reason: item.decisionReason ?? '' }, ctx());
      case 'merged':
      case 'suppressed':
      case 'covered':
        return machine.archiveDecision(glob, `The knowledge pipeline closed the item as ${item.status}`, ctx());
    }
  });
  if (!step.ok) throw new Error(step.error.message);
  if (step.value.changed) changed(step.value.glob);
  let glob = step.value.glob;

  if (item.status === 'open') {
    const flagged = await refreshConflicts(tx, clock, item, glob);
    if (flagged) {
      glob = (await tx.getGlob(glob.id)) ?? glob;
      changed(glob);
    }
    const attributes = decisionOf(glob);
    const hasAssessment = (await tx.artifactVersions(glob.id, 'assessment', '')).length > 0;
    // Written at creation, and again when the pipeline drafts (the diff is new information) or the conflict flags move.
    if (attributes !== null && AUTOMATED.includes(attributes.channel) && (!hasAssessment || item.processing === 'drafted' || flagged)) {
      if (await writeAssessment(tx, { clock }, glob, item, preview)) hints.push({ kind: 'glob.artifacts', boardId: glob.boardId, globId: glob.id });
    }
  } else if (item.status === 'approved') {
    // A broader decision was accepted: the narrower open ones that contradict it may now conflict with it.
    for (const other of await tx.listKbItems(item.boardId, 'open')) {
      if (!other.contradicts.some((c) => c.kind === 'item' && c.ref === item.id)) continue;
      const otherGlob = await globOfItem(tx, other);
      if (otherGlob !== null && (await refreshConflicts(tx, clock, other, otherGlob))) {
        changed((await tx.getGlob(otherGlob.id)) ?? otherGlob);
      }
    }
  }
  return hints;
};
