import { isAgentSetKind } from '@slop/core';
import type { DecisionAttributes, DecisionLearning, DecisionOutcomeKind, KbTarget, KnowledgeKind } from '@slop/core';

export const OUTCOME_TEXT: Record<DecisionOutcomeKind, string> = {
  accept: 'Accepted',
  accept_with_edits: 'Accepted with edits',
  retarget: 'Retargeted',
  needs_work: 'Needs work',
  reject: 'Rejected',
  closed: 'Closed by the pipeline',
};

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

/** What confirming an approval says it will do, and the label of its Confirm button: one text per kind of decision, never a generic one. */
export const acceptConfirm = ({
  hotspot,
  learning,
  document,
  target,
  title,
  label,
}: {
  hotspot: boolean;
  learning: boolean;
  document: boolean;
  target: KbTarget | null;
  title: string;
  label: string;
}): { text: string; button: string } => {
  if (hotspot) return { text: `Creates a refactor glob from this proposal (${title}), linked to this decision, and marks the decision approved.`, button: 'Create' };
  if (!learning) return { text: 'Records this choice; globs it holds back can start.', button: 'Approve' };
  if (document) return { text: `Creates or updates the proposed document${target === null ? '' : ` ${target.name}`}, then moves this decision to Reviewing.`, button: label };
  const where = target === null ? 'its target' : target.section === null ? target.name : `${target.name} › ${target.section}`;
  return { text: `Applies the change to ${where}, then moves this decision to Reviewing.`, button: label };
};

/** Why a PO may not decide a change to this target (as core refuses it), or null. Agent behaviour and what slop runs or enforces are for admins. */
export const adminOnlyReason = (kind: KnowledgeKind | undefined): string | null => {
  if (kind === undefined) return null;
  if (isAgentSetKind(kind)) return 'changes an agent-set file, which changes how agents behave';
  if (kind === 'local_run') return "changes the local-run spec, which sstor runs on developers' machines";
  if (kind === 'merge_policy') return 'changes the merge policy, which decides which globs wait for each other';
  return null;
};

/** How a draft changes its target section: it creates the section, only adds to it, edits it, or changes nothing. */
export type ChangeKind = 'new_section' | 'addition' | 'edit' | 'none';

/**
 * Which kind of change a preview is. A new section only when the API says the section did not exist before (an older
 * server sends nothing, and the change is then never called new); an empty diff is no change, never an addition.
 */
export const changeKindOf = (diff: readonly { readonly op: string }[], sectionExisted?: boolean): ChangeKind => {
  const added = diff.some((l) => l.op === 'added');
  const removed = diff.some((l) => l.op === 'removed');
  if (!added && !removed) return 'none';
  if (sectionExisted === false && added && !removed) return 'new_section';
  return added && !removed ? 'addition' : 'edit';
};

/** The change's heading in words: what it edits and where, from its target and what kind of change the draft is. */
export const changeHeading = (target: KbTarget | null, kind: ChangeKind): string | null => {
  if (target === null) return null;
  if (target.kind === 'merge_policy') return 'Merge policy setting';
  if (target.kind === 'local_run') return 'Local-run spec';
  if (target.newDocument !== null) return `New document ${target.name}`;
  const where = target.section === null ? target.name : `${target.name} › ${target.section}`;
  switch (kind) {
    case 'new_section':
      return target.section === null ? `Addition to ${where}` : `New section in ${where}`;
    case 'addition':
      return `Addition to ${where}`;
    case 'none':
      return `No change to ${where}`;
    case 'edit':
      return `Edit to ${where}`;
  }
};

/** Whether a scope is worth showing: not for a change routed to a document or a setting, which applies wherever it is written. */
export const scopeMatters = (document: boolean, hotspot: boolean, target: KbTarget | null): boolean => !document && !hotspot && target === null;

/** What each scope kind means, for the explained options. */
export const SCOPE_EXPLAINED = {
  glob: 'This glob only',
  future_work: 'All new globs (blank group), or new globs in one group',
  area_group: 'Globs in one group',
  project: 'The whole project (existing and new globs)',
} as const;

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
 * The ▾ next to the primary button, in the order a person is likely to want them: Reject…, approve with edits, keeping the
 * statement without changing a document, a new recommendation, then the outcomes that stay available (retarget, needs work).
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
  return [
    { key: 'reject', label: 'Reject…', tip: 'Turn the proposal down, with a reason', disabled: noDecide },
    { key: 'accept_with_edits', label: 'Approve with edits…', tip: 'Edit the draft, then approve it with your wording', disabled: noDecide ?? noItem ?? adminEdits },
    ...(canKeep ? [{ key: 'keep', label: 'Approve without changing a document', tip: KEEP_TIP, disabled: noDecide } satisfies MenuEntry] : []),
    ...(canSuggest ? [{ key: 'suggest', label: 'Get a new recommendation', tip: SUGGEST_TIP, disabled: null } satisfies MenuEntry] : []),
    { key: 'retarget', label: 'Retarget', tip: 'Point the proposal at another document or file; it is drafted again', disabled: noDecide ?? noItem },
    { key: 'needs_work', label: 'Needs work', tip: 'Some work has to land first; the decision waits for it to merge', disabled: noDecide },
  ];
};

/** What the block's submit button says for the form that is open. */
export const submitLabel = (mode: Choice, approve: string): string => {
  switch (mode) {
    case 'accept':
      return approve;
    case 'accept_with_edits':
      return 'Save';
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
