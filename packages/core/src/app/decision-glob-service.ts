import { err, forbidden, invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import * as machine from '../domain/machine.js';
import type { Context } from '../domain/machine.js';
import { decisionOf, hotspotOf, hotspotRefactorKey } from '../domain/decision-glob.js';
import type { EffectCheck } from '../domain/effect-check.js';
import { knowledgePageEffect } from '../domain/events.js';
import type { DecisionOutcomeKind } from '../domain/attributes.js';
import type { DraftPreview, KbDraft, LearningStatus, KbProcessing, KbTarget } from '../domain/kb.js';
import { isLearning, learningAssessmentFacts, learningDocument, learningDraft, learningEffectCheck, learningStatus, learningTarget, pipelineState } from '../domain/learning.js';
import type { LearningRead } from '../domain/learning.js';
import { isAgentSetKind } from '../domain/knowledge.js';
import type { Artifact, KnowledgeKind } from '../domain/knowledge.js';
import type { Glob, Role } from '../domain/types.js';
import type { Clock, Hint, Notifier, Store, Tx } from '../ports.js';
import { memberOf, roleOf } from './access.js';
import { sectionText } from '../domain/sections.js';
import { applyDecisionStep, createDecisionForExtracted, decisionContext, writeAssessment, writeLeaning } from './decision-glob.js';
import type { GlobService } from './glob-service.js';
import type { Approval, KnowledgeService, TargetChange } from './knowledge-service.js';
import { readLearning } from './learning-reads.js';

/** Who may decide a decision glob, and so a KB item through it. */
const DECIDERS: readonly Role[] = ['admin', 'po'];

/** What a person chooses for a decision in Doing (`POST /api/globs/:id/decision`). */
export interface DecideRequest {
  readonly outcome: Exclude<DecisionOutcomeKind, 'closed'>;
  /** Required to reject. */
  readonly reason?: string | undefined;
  /** Accept with edits: the edited draft (the section text, or a new document's body). */
  readonly editedDraft?: string | undefined;
  /** Retarget: where the item belongs instead. */
  readonly target?: TargetChange | undefined;
  /** Needs work: an existing board glob that will make the change; without one, a work glob is created. */
  readonly linkedGlobId?: string | undefined;
  /** Accept (with or without edits) a learning without a signal: the key of a measured signal for the effect check to watch. */
  readonly watchSignal?: string | undefined;
}

/** What a decision would change: the item's target and the diff against the target's current text (null: no item or no draft yet). */
export interface DecisionDiff {
  readonly target: KbTarget | null;
  readonly currentVersion: number | null;
  readonly preview: DraftPreview | null;
  /** The drafted text (what Accept with edits starts from): a section's new text, or a new document's whole body. */
  readonly draft: KbDraft | null;
  /** The learning's own state, which the decision view shows beside the change (null: no learning). */
  readonly learning: DecisionLearning | null;
  /** Whether the section the draft writes to is in the target now (false: the change adds a new section). Only with a draft in a section; absent from older servers. */
  readonly sectionExisted?: boolean;
}

/** Where a learning is: whether it is still open, the pipeline's step and its failures, and the effect check of an approved change. */
export interface DecisionLearning {
  readonly status: LearningStatus;
  readonly processing: KbProcessing;
  readonly processingError: string | null;
  readonly processingAttempts: number;
  /** When the pipeline's next try is due (while retrying, the claim's lease once a try is running). */
  readonly processAfter: string | null;
  readonly effectCheck: EffectCheck | null;
}

/** The glob's conditional write lost to a concurrent one: thrown so the KB writes made beside it roll back too. */
class StaleDecisionGlob extends Error {
  constructor(id: string) {
    super(`Decision ${id} changed during the decision`);
  }
}

/** What a PO may not change: agent behaviour and what slop itself runs or enforces. Null when allowed. */
const keptForAdmins = (kind: KnowledgeKind | undefined): string | null => {
  if (kind === undefined) return null;
  if (isAgentSetKind(kind)) return 'changes an agent-set file, which changes how agents behave';
  if (kind === 'local_run') return "changes the local-run spec, which sstor runs on developers' machines";
  if (kind === 'merge_policy') return 'changes the merge policy, which decides which globs wait for each other';
  return null;
};

/**
 * The five outcomes of a decision glob. A learning's decision *is* its KB item: accept, accept with edits and reject are
 * the item's approval or rejection (whose write is the decision's transition), retarget points it at another target,
 * and needs work links the glob that will make the change. A decision with no learning records the outcome only.
 */
export class DecisionGlobService {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      notifier: Notifier;
      knowledge: KnowledgeService;
      /** Creates the work glob a needs-work decision waits on. */
      globs: GlobService;
    },
  ) {}

  private context(actor: { email: string; role: Role } | null): Context {
    return decisionContext(this.deps.clock, actor);
  }

  /**
   * The five outcomes. Accept and accept with edits apply the item's draft (or the edited one) to its target and move the
   * glob to Reviewing; retarget points the item at another target to be drafted again (the glob stays in Doing); needs
   * work links the glob that will make the change (created when none is given) and waits for it to merge; reject rejects
   * the item with the reason and signs the glob off, archived. The glob must be in Doing, picked up by an admin or PO.
   * Conditional on the glob's `version`; the item write and the glob write commit together or not at all.
   */
  async decide(email: string, id: string, version: number, input: DecideRequest): Promise<Result<Glob>> {
    const shape = this.checkRequest(input);
    if (!shape.ok) return shape;
    const read = await this.deps.store.transaction(async (tx) => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      if (decisionOf(glob) === null) return invalidInput(`${id} is not a decision glob`);
      const actor = await roleOf(tx, email, glob.boardId, DECIDERS);
      if (!actor.ok) return actor;
      // Needs work without a glob to link makes one below: check the request would be accepted first, so a refusal leaves no stray glob.
      if (input.outcome === 'needs_work' && input.linkedGlobId === undefined) {
        if (glob.version !== version) return err({ code: 'version_conflict', message: 'The glob has changed', current: glob });
        const check = machine.decideDecision(glob, { outcome: 'needs_work', ...(input.reason === undefined ? {} : { reason: input.reason }), linkedGlobId: glob.id }, this.context(actor.value));
        if (!check.ok) return check;
      }
      // Accepting a hotspot makes the refactor glob below: check the request would be accepted first, for the same reason.
      if (hotspotOf(glob) !== null && input.outcome === 'accept' && glob.version === version) {
        const check = machine.decideDecision(glob, { outcome: 'accept', linkedGlobId: glob.id }, this.context(actor.value));
        if (!check.ok) return check;
      }
      const plan = (await tx.listArtifacts(id, 'plan'))[0]?.content ?? '';
      return ok({ glob, plan });
    });
    if (!read.ok) return read;
    const { glob: seen, plan } = read.value;

    // Needs work without a glob to link: create the work glob first (it is its own idempotent transaction, keyed on the decision).
    let linkedGlobId = input.linkedGlobId;
    if (input.outcome === 'needs_work' && linkedGlobId === undefined && seen.version === version && seen.status === 'in_progress') {
      const created = await this.deps.globs.create(email, {
        boardId: seen.boardId,
        title: `${seen.id}: ${seen.title}`.slice(0, 200),
        type: 'same',
        category: 'task',
        group: seen.group,
        environment: null,
        autoTrigger: false,
        idempotencyKey: `decision-work:${seen.id}`,
        plan: `Make the change decision ${seen.id} asks for.\n\n${input.reason === undefined ? '' : `Why it needs work: ${input.reason.trim()}\n\n`}${plan}`,
        planBy: 'human',
      });
      if (!created.ok) return created;
      linkedGlobId = created.value.id;
    }

    // Accepting a hotspot creates the refactor glob, which waits for the globs now changing the file (idempotent on the decision).
    const hotFile = hotspotOf(seen);
    if (hotFile !== null && input.outcome === 'accept' && seen.version === version && seen.status === 'in_progress') {
      const created = await this.deps.globs.create(email, {
        boardId: seen.boardId,
        title: `Refactor ${hotFile.split('/').at(-1) ?? hotFile} so parallel work stops conflicting`.slice(0, 200),
        type: 'same',
        category: 'task',
        group: seen.group,
        environment: null,
        autoTrigger: false,
        idempotencyKey: hotspotRefactorKey(seen.id),
        after: await this.deps.globs.openGlobsTouching(seen.boardId, hotFile),
        plan: `Refactor \`${hotFile}\`, a conflict hotspot (decision ${seen.id}).\n\n${plan.trim()}\n\n## Files\n\n- ${hotFile}\n`,
        planBy: 'human',
      });
      if (!created.ok) return created;
      linkedGlobId = created.value.id;
    }

    // A learning's decision is the KB item itself (same ID).
    const itemId = isLearning(seen) ? seen.id : null;
    let hints: readonly Hint[] = [];
    let result: Result<Glob>;
    try {
      result = await this.deps.knowledge.inTransaction(itemId, async (tx): Promise<Result<Glob>> => {
        const glob = await tx.getGlob(id);
        if (glob === null) return notFound(`No glob ${id}`);
        if (glob.version !== version) return err({ code: 'version_conflict', message: 'The glob has changed', current: glob });
        const actor = await roleOf(tx, email, glob.boardId, DECIDERS);
        if (!actor.ok) return actor;
        const machineInput: machine.DecideInput = {
          outcome: input.outcome,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(linkedGlobId === undefined ? {} : { linkedGlobId }),
        };
        // The pure step first: it refuses a wrong state or role before anything is written.
        const transition = machine.decideDecision(glob, machineInput, this.context(actor.value));
        if (!transition.ok) return transition;
        if (input.outcome === 'needs_work' && linkedGlobId !== undefined) {
          const linked = await this.checkLinked(tx, glob, linkedGlobId);
          if (!linked.ok) return linked;
        }
        const written = await this.writeItem(tx, email, glob, actor.value.role, input);
        if (!written.ok) return written;
        // Accepting or rejecting changes the decisions in force: the knowledge page regenerates (coalesced, and not sooner than its interval).
        if (input.outcome === 'accept' || input.outcome === 'accept_with_edits' || input.outcome === 'reject') await tx.enqueueEffects([knowledgePageEffect(glob.boardId)]);
        // Writing the item rewrites this very glob, so the step is applied to the glob as it is now.
        const fresh = await tx.getGlob(id);
        if (fresh === null) throw new StaleDecisionGlob(id);
        if (written.value) {
          // An accept or reject of a learning: its write was the decision's transition (the step above only checked it may happen).
          hints = [{ kind: 'glob.changed', boardId: fresh.boardId, globId: fresh.id, version: fresh.version }];
          return ok(fresh);
        }
        let step = transition.value;
        if (fresh.version !== glob.version) {
          const again = machine.decideDecision(fresh, machineInput, this.context(actor.value));
          if (!again.ok) throw new StaleDecisionGlob(id);
          step = again.value;
        }
        const { changed, events, effects } = step;
        let current = fresh;
        if (changed) {
          current = { ...step.glob, version: fresh.version + 1 };
          // The KB writes above are in this transaction: a lost race must roll them back, not return a result.
          if (!(await tx.updateGlob(current, fresh.version))) throw new StaleDecisionGlob(glob.id);
          hints = [{ kind: 'glob.changed', boardId: current.boardId, globId: current.id, version: current.version }];
        }
        await tx.appendEvents(events);
        await tx.enqueueEffects(effects);
        return ok(current);
      });
    } catch (error) {
      if (!(error instanceof StaleDecisionGlob)) throw error;
      const current = await this.deps.store.transaction((tx) => tx.getGlob(id));
      return current === null ? notFound(`No glob ${id}`) : err({ code: 'version_conflict', message: 'The glob has changed', current });
    }
    for (const hint of hints) this.deps.notifier.publish(hint);
    return result;
  }

  private checkRequest(input: DecideRequest): Result<null> {
    if (input.outcome === 'accept_with_edits' && (input.editedDraft ?? '').trim() === '') return invalidInput('Accept with edits needs the edited draft');
    if (input.outcome !== 'accept_with_edits' && input.editedDraft !== undefined) return invalidInput('editedDraft is for accept with edits');
    if (input.outcome === 'retarget' && input.target === undefined) return invalidInput('Retarget needs the new target');
    if (input.outcome !== 'retarget' && input.target !== undefined) return invalidInput('target is for retarget');
    if (input.outcome === 'reject' && (input.reason ?? '').trim() === '') return invalidInput('Rejecting needs a reason');
    if (input.outcome !== 'needs_work' && input.linkedGlobId !== undefined) return invalidInput('linkedGlobId is for needs work');
    if (input.watchSignal !== undefined && input.outcome !== 'accept' && input.outcome !== 'accept_with_edits') return invalidInput('watchSignal is for accepting');
    return ok(null);
  }

  /** The glob a needs-work decision waits on: a work glob of the board that has not merged yet. */
  private async checkLinked(tx: Tx, decision: Glob, linkedId: string): Promise<Result<Glob>> {
    const linked = await tx.getGlob(linkedId);
    if (linked?.boardId !== decision.boardId) return notFound(`No glob ${linkedId} on board ${String(decision.boardId)}`);
    if (linked.category === 'decision') return invalidInput('Link a work glob, not another decision');
    if (linked.status === 'signed_off' || linked.status === 'merging') return invalidInput(`${linkedId} has already merged or is merging: link a glob that has not`);
    return ok(linked);
  }

  /**
   * The knowledge-base side of an outcome, in the caller's transaction: true when the learning's write moved the decision
   * itself (accept, accept with edits, reject). A decision with no learning records the outcome only.
   */
  private async writeItem(tx: Tx, email: string, glob: Glob, role: Role, input: DecideRequest): Promise<Result<boolean>> {
    const itemId = isLearning(glob) ? glob.id : null;
    if (input.outcome === 'needs_work') return ok(false);
    if (itemId === null) {
      return input.outcome === 'accept_with_edits' || input.outcome === 'retarget'
        ? invalidInput('This decision has no knowledge item, so there is nothing to edit or retarget')
        : ok(false);
    }
    const learning = await readLearning(tx, itemId);
    if (learning === null) return notFound(`No KB item ${itemId}`);
    const { version } = learning.glob;
    const status = learningStatus(learning.glob, learning.artifacts);
    if (status !== 'open') {
      // A reopened decision whose item was approved stays accepted: accepting again only records the outcome.
      if (status === 'approved' && input.outcome === 'accept') return ok(false);
      return invalidInput(`${itemId} is already ${status}: change it on the Knowledge page first`);
    }
    if (role === 'po') {
      if (input.watchSignal !== undefined) return forbidden(`${itemId}: an admin chooses the signal an approval watches`);
      const refusal = keptForAdmins(input.outcome === 'retarget' ? input.target?.kind : learningTarget(learning.glob).routed?.kind);
      if (refusal !== null && input.outcome !== 'reject') return forbidden(`${itemId} ${refusal}: an admin decides it`);
    }
    const knowledge = this.deps.knowledge;
    switch (input.outcome) {
      case 'accept':
      case 'accept_with_edits': {
        const approval = this.approvalFor(learning, input);
        if (!approval.ok) return approval;
        const approved = await knowledge.approveIn(tx, email, itemId, version, approval.value, DECIDERS);
        return approved.ok ? ok(true) : approved;
      }
      case 'retarget': {
        if (input.target === undefined) return invalidInput('Retarget needs the new target');
        const moved = await knowledge.changeTargetIn(tx, email, itemId, version, input.target, DECIDERS);
        return moved.ok ? ok(false) : moved;
      }
      case 'reject': {
        const rejected = await knowledge.rejectIn(tx, email, itemId, version, input.reason ?? '', DECIDERS);
        return rejected.ok ? ok(true) : rejected;
      }
    }
  }

  /** Accept applies the draft; a learning the pipeline never drafted (routing gave up) is kept as a learning; one still routing waits. */
  private approvalFor(learning: LearningRead, input: DecideRequest): Result<Approval> {
    const watch = input.watchSignal === undefined ? {} : { watchSignal: input.watchSignal };
    if (input.outcome === 'accept_with_edits') return ok({ as: 'draft', content: input.editedDraft ?? '', ...watch });
    const { glob, artifacts } = learning;
    if (learningDocument(glob, artifacts) !== null || learningDraft(artifacts) !== null) return ok({ as: 'draft', ...watch });
    const { processing } = pipelineState(glob, artifacts, learning.jobs);
    if (processing === 'pending' || processing === 'routed') return invalidInput(`${glob.id} is not drafted yet: wait for the pipeline, or retarget it`);
    return ok({ as: 'learning', ...watch });
  }

  /**
   * The glob view's Reopen: a learning the KB pipeline closed (merged, suppressed, covered) is reopened as the Knowledge
   * page reopens it (admins; row D12, back to Planning, a merge kept apart), an accepted decision in Reviewing goes back
   * to Doing to choose again (row D9). Conditional on the glob's version.
   */
  async reopen(email: string, id: string, version: number): Promise<Result<Glob>> {
    const glob = await this.deps.store.transaction((tx) => tx.getGlob(id));
    if (glob === null) return notFound(`No glob ${id}`);
    if (decisionOf(glob)?.closedAs === undefined) return this.deps.globs.reopenDecision(email, id, version);
    const reopened = await this.deps.knowledge.reopen(email, id, version);
    if (!reopened.ok) {
      if (reopened.error.code !== 'version_conflict') return reopened;
      const current = await this.deps.store.transaction((tx) => tx.getGlob(id));
      return current === null ? notFound(`No glob ${id}`) : err({ code: 'version_conflict', message: 'The glob has changed', current });
    }
    const current = await this.deps.store.transaction((tx) => tx.getGlob(id));
    return current === null ? notFound(`No glob ${id}`) : ok(current);
  }

  /**
   * A work glob merged (the `release_waiting` effect): the needs-work decisions that waited on it move to Reviewing. Each is
   * its own version-checked write and a repeat changes nothing. Returns the decisions moved.
   */
  async linkedMerged(mergedGlobId: string, boardId: number): Promise<string[]> {
    const waiting = await this.deps.store.transaction((tx) => tx.listGlobs(boardId, { include: 'decisions', status: ['in_progress'] }));
    const moved: string[] = [];
    for (const decision of waiting) {
      const outcome = decisionOf(decision)?.outcome;
      if (outcome?.kind !== 'needs_work' || outcome.linkedGlobId !== mergedGlobId) continue;
      const step = await this.deps.store.transaction((tx) => applyDecisionStep(tx, decision.id, (glob) => machine.decisionWorkLanded(glob, this.context(null))));
      if (step.ok && step.value.changed) {
        moved.push(decision.id);
        this.deps.notifier.publish({ kind: 'glob.changed', boardId, globId: decision.id, version: step.value.glob.version });
      }
    }
    return moved;
  }

  /** The proposed change behind a decision, as the Knowledge page previews it. Members read it. */
  async diff(email: string, id: string): Promise<Result<DecisionDiff>> {
    return this.deps.store.transaction(async (tx): Promise<Result<DecisionDiff>> => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      const attributes = decisionOf(glob);
      if (attributes === null) return invalidInput(`${id} is not a decision glob`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const learning = isLearning(glob) ? await readLearning(tx, glob.id) : null;
      if (learning === null) return ok({ target: null, currentVersion: null, preview: null, draft: null, learning: null });
      const preview = await this.deps.knowledge.previewFor(tx, learning);
      const document = learningDocument(learning.glob, learning.artifacts);
      const draft = document === null ? (learningDraft(learning.artifacts)?.draft ?? null) : { section: null, content: document.content };
      const state = pipelineState(learning.glob, learning.artifacts, learning.jobs);
      const targetNow = document === null && draft?.section != null && preview !== null ? await this.deps.knowledge.targetStateFor(tx, learning) : null;
      return ok({
        target: learningTarget(learning.glob).routed,
        currentVersion: preview?.version ?? null,
        preview,
        draft,
        learning: {
          status: learningStatus(learning.glob, learning.artifacts),
          processing: state.processing,
          processingError: state.error,
          processingAttempts: state.attempts,
          processAfter: state.runAfter,
          effectCheck: learningEffectCheck(learning.artifacts),
        },
        ...(targetNow === null || draft?.section == null ? {} : { sectionExisted: sectionText(targetNow.text, draft.section) !== null }),
      });
    });
  }

  /** Writes (or refreshes) the glob's assessment now: for decisions that came from people, and the Assess button. */
  async assess(email: string, id: string): Promise<Result<Artifact>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<{ artifact: Artifact; changed: boolean; boardId: number }>> => {
      const glob = await tx.getGlob(id);
      if (glob === null) return notFound(`No glob ${id}`);
      if (decisionOf(glob) === null) return invalidInput(`${id} is not a decision glob`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const learning = isLearning(glob) ? await readLearning(tx, glob.id) : null;
      const preview = learning === null ? null : await this.deps.knowledge.previewFor(tx, learning);
      const facts = learning === null ? null : learningAssessmentFacts(learning);
      const written = await writeAssessment(tx, { clock: this.deps.clock }, glob, facts, preview);
      const leaned = learning === null || facts === null ? false : await writeLeaning(tx, { clock: this.deps.clock }, glob, facts, preview, learning.artifacts.draft?.version ?? null);
      const changed = written || leaned;
      const latest = (await tx.artifactVersions(id, 'assessment', '')).at(-1);
      return latest === undefined ? invalidInput('No assessment could be written') : ok({ artifact: latest, changed, boardId: glob.boardId });
    });
    if (!result.ok) return result;
    if (result.value.changed) this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: result.value.boardId, globId: id });
    return ok(result.value.artifact);
  }

  /**
   * Promotes a decision extracted from a glob's record or an inbox item to a decision glob in Planning, for a person to
   * pick up. It has no knowledge item (accepting records the outcome only). Idempotent on the decision.
   */
  async promoteExtracted(email: string, boardId: number, decisionId: number): Promise<Result<Glob>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<{ glob: Glob; hints: readonly Hint[] }>> => {
      const actor = await memberOf(tx, email, boardId);
      if (!actor.ok) return actor;
      const decision = await tx.getDecision(decisionId);
      if (decision?.boardId !== boardId) return notFound(`No decision ${String(decisionId)} on board ${String(boardId)}`);
      const created = await createDecisionForExtracted(tx, { clock: this.deps.clock }, decision, actor.value, 'human');
      return created.ok ? ok({ glob: created.value.glob, hints: created.value.hints }) : created;
    });
    if (!result.ok) return result;
    for (const hint of result.value.hints) this.deps.notifier.publish(hint);
    return ok(result.value.glob);
  }
}
