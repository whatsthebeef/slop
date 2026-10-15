import { isAgentSetKind } from '@slop/core';
import type { DecisionAttributes, DecisionLearning, DecisionOutcomeKind, KbTarget, KnowledgeKind } from '@slop/core';

export type Choice = Exclude<DecisionOutcomeKind, 'closed'>;

/** What the outcome controls are showing a form for: one of the outcomes, or keeping the statement as an approved learning. */
export type FlowMode = Choice | 'keep';

/** The header's main action, whatever the item is; the block's own button names the target (see `approveLabel`). */
export const APPROVE_CHANGE = 'Approve change';

/** What approving the change is called for this proposal, and what it does. */
export const approveLabel = (document: boolean, target: KbTarget | null, hotspot = false): { label: string; tip: string } => {
  if (hotspot) return { label: 'Create refactor glob', tip: 'Create a glob that refactors this file; it starts once the globs now changing the file have merged' };
  if (document) return { label: 'Approve document', tip: 'Create or update the proposed document (whole documents always need a person)' };
  if (target?.kind === 'merge_policy') return { label: 'Approve merge policy', tip: 'Replace the merge policy with the proposed one' };
  if (target?.kind === 'local_run') return { label: 'Approve local-run spec', tip: 'Replace the local-run spec with the proposed one' };
  return { label: APPROVE_CHANGE, tip: 'Approves the proposed change as drafted' };
};

/** Why a PO may not decide a change to this target (as core refuses it), or null. Agent behaviour and what slop runs or enforces are for admins. */
export const adminOnlyReason = (kind: KnowledgeKind | undefined): string | null => {
  if (kind === undefined) return null;
  if (isAgentSetKind(kind)) return 'changes an agent-set file, which changes how agents behave';
  if (kind === 'local_run') return "changes the local-run spec, which sstor runs on developers' machines";
  if (kind === 'merge_policy') return 'changes the merge policy, which decides which globs wait for each other';
  return null;
};

export const PERSON_ONLY_NOTICE = 'Only a person can approve this kind of change';

/** The notice for a kind of change agents are never allowed to approve (specs, agent-set files, whole documents), or null. */
export const personOnlyNotice = (document: boolean, kind: KnowledgeKind | undefined): string | null =>
  document || kind === 'merge_policy' || kind === 'local_run' || (kind !== undefined && isAgentSetKind(kind)) ? PERSON_ONLY_NOTICE : null;

/** The header's text when the viewer can't approve this change themselves. */
export const approveBlockedText = (adminOnly: string | null, canDecide: boolean): string | null => {
  if (!canDecide) return "You can't decide this";
  return adminOnly === null ? null : `An admin approves it: it ${adminOnly}`;
};

export type MenuKey = 'reject' | 'keep' | 'suggest' | 'accept_with_edits' | 'retarget' | 'needs_work';

export interface MenuEntry {
  readonly key: MenuKey;
  readonly label: string;
  readonly tip: string;
  /** Why it can't be chosen now, or null. */
  readonly disabled: string | null;
}

export const KEEP_TIP = 'Store it as an approved learning agents are given, without editing a document';

const SUGGEST_TIP =
  'Ask the model what to do with this: approve, approve with an edit, merge into another learning, or reject. It reads the draft, the target section, the sibling learnings and the changes merged since';

/**
 * The ▾ next to Approve change, in the order a person is likely to want them: Reject…, keeping the statement without
 * changing a document, Suggest again, then the outcomes that stay available (accept with edits, retarget, needs work).
 */
export const headerMenu = ({
  canDecide,
  canSuggest,
  canKeep,
  hasItem,
  adminOnly,
}: {
  canDecide: boolean;
  canSuggest: boolean;
  /** An admin on an open learning that is not a whole document. */
  canKeep: boolean;
  hasItem: boolean;
  adminOnly: string | null;
}): MenuEntry[] => {
  const noDecide = canDecide ? null : "You can't decide this";
  const noItem = !hasItem ? 'This decision has no knowledge item to edit or retarget' : null;
  const adminEdits = adminOnly === null ? null : `An admin decides it: it ${adminOnly}`;
  const entries: MenuEntry[] = [{ key: 'reject', label: 'Reject…', tip: 'Turn the proposal down, with a reason', disabled: noDecide }];
  if (canKeep) entries.push({ key: 'keep', label: 'Approve without changing a document', tip: KEEP_TIP, disabled: noDecide });
  if (canSuggest) entries.push({ key: 'suggest', label: 'Suggest again', tip: SUGGEST_TIP, disabled: null });
  entries.push(
    { key: 'accept_with_edits', label: 'Accept with edits', tip: 'Apply the change with your own wording', disabled: noDecide ?? noItem ?? adminEdits },
    { key: 'retarget', label: 'Retarget', tip: 'Point the proposal at another document or file; it is drafted again', disabled: noDecide ?? noItem },
    { key: 'needs_work', label: 'Needs work', tip: 'Some work has to land first; the decision waits for it to merge', disabled: noDecide },
  );
  return entries;
};

/** What the block's submit button says for the form that is open. */
export const submitLabel = (mode: Choice, approve: string): string => {
  switch (mode) {
    case 'accept':
      return approve;
    case 'accept_with_edits':
      return 'Accept with edits';
    case 'retarget':
      return 'Retarget';
    case 'needs_work':
      return 'Needs work';
    case 'reject':
      return 'Reject';
  }
};

/**
 * Which Watch signal step an approval offers: a choice among the board's signals for a statement without a signal of its
 * own, or the one line naming the signal an item mined from one watches itself. None for a whole document or a closed learning.
 */
export const watchMode = (learning: DecisionLearning | null, attributes: DecisionAttributes): 'choose' | 'own' | null => {
  if (learning?.status !== 'open' || attributes.document !== undefined) return null;
  return attributes.signal === undefined ? 'choose' : 'own';
};

/** The note for a decision that contradicts broader-scope ones, or null. */
export const conflictNote = (conflicts: readonly string[]): string | null =>
  conflicts.length === 0 ? null : 'Conflicts with a broader-scope decision, which wins where they disagree';
