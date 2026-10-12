/**
 * The board's knowledge page: a generated, versioned summary of the agents and skills and the key decisions in force.
 * Each regeneration is a new version, so an earlier one can be read back; the generated page is data, not a document,
 * and nobody edits it. The agents come from the board's data; only the decisions section is written by a model, and
 * only from what changed since the previous version.
 */

/** Bump to rebuild every board's page in full at its next regeneration (the model's instructions changed). */
export const KNOWLEDGE_PAGE_PROMPT_VERSION = 2;

/** How often the page may regenerate (minutes): the board setting's default and bounds. */
export const KNOWLEDGE_PAGE_INTERVAL_DEFAULT = 1440;
export const KNOWLEDGE_PAGE_INTERVAL_MIN = 5;
export const KNOWLEDGE_PAGE_INTERVAL_MAX = 1440;

/** The page remembers (and the Agent set section lists) this many observed agent-set versions. */
export const KNOWLEDGE_PAGE_AGENT_SET_HISTORY_MAX = 10;
/** A full rebuild covers at most this many decisions in force (the newest), so one call stays small. */
export const KNOWLEDGE_PAGE_DECISIONS_MAX = 150;

/** Why a version was written: the first one, a delta on the previous, an admin's Rebuild, a changed prompt, or a changed guide. */
export const KNOWLEDGE_PAGE_REASONS = ['first', 'delta', 'rebuild', 'prompt', 'guide'] as const;
export type KnowledgePageReason = (typeof KNOWLEDGE_PAGE_REASONS)[number];

/** An agent or command (skill) in the board's agent set, read from its file. */
export interface KnowledgePageAgent {
  readonly path: string;
  readonly kind: 'agent' | 'command';
  readonly name: string;
  readonly description: string;
  /** Hash of the file as served. */
  readonly hash: string;
  /** The agent-set version at which the page first saw this file's current text; null on the page's first version. */
  readonly changedInAgentSet: number | null;
  /** The newest accepted decision glob that targets this file, when there is one. */
  readonly decisionGlobId: string | null;
}

/** Decisions in force under one area, as the model wrote them. Entries link to the decision globs through `globIds`. */
export interface KnowledgePageDecisionEntry {
  readonly text: string;
  readonly rationale: string;
  readonly globIds: readonly string[];
  /** A new developer or the product owner would need it. Absent on versions written before the flag existed. */
  readonly key?: boolean;
  /** What the model said when a pin or a "not key" verdict overrides `key`; absent when `key` is the model's. */
  readonly modelKey?: boolean;
  /** When the newest decision behind the entry was decided; absent on older versions. */
  readonly at?: string;
}

export interface KnowledgePageDecisionGroup {
  readonly area: string;
  readonly entries: readonly KnowledgePageDecisionEntry[];
}

export interface KnowledgePageSections {
  readonly agents: readonly KnowledgePageAgent[];
  readonly decisions: readonly KnowledgePageDecisionGroup[];
}

/** Which sections this version rewrote (the others are as the previous version had them). */
export interface KnowledgePageChanged {
  readonly agents: boolean;
  readonly decisions: boolean;
}

/** What a version was built from: the "nothing changed" check and the next delta compare against it. */
export interface KnowledgePageBasis {
  readonly agentSetVersion: number;
  /** Hash of every agent file's path and text. */
  readonly agentsHash: string;
  /** Per file: the hash of its text and the agent-set version it was first seen at (null: on the first version). */
  readonly agentSeen: Readonly<Record<string, { readonly hash: string; readonly since: number | null }>>;
  /** Decision glob ID to a fingerprint of what the decisions section says about it. */
  readonly decisions: Readonly<Record<string, string>>;
  readonly promptVersion: number;
  /** Version of the board's `knowledge-page-guide` document it was built with; absent on versions written before the guide. */
  readonly guideVersion?: number;
  /** Decision glob ID to the verdict in force when it was built; absent on versions written before the feedback. */
  readonly feedback?: Readonly<Record<string, KnowledgePageVerdict>>;
  /** The agent-set versions this page observed, with when it first saw each and which agent files moved with it (the Agent set section's history). */
  readonly agentSetBumps: readonly { readonly version: number; readonly at: string; readonly changedPaths: readonly string[] }[];
}

export interface KnowledgePageVersion {
  readonly boardId: number;
  readonly version: number;
  readonly createdAt: string;
  readonly reason: KnowledgePageReason;
  readonly sections: KnowledgePageSections;
  readonly changed: KnowledgePageChanged;
  readonly basis: KnowledgePageBasis;
}

/** A version without its sections: what the history list shows. */
export interface KnowledgePageHistoryEntry {
  readonly version: number;
  readonly createdAt: string;
  readonly reason: KnowledgePageReason;
}

/** The page as the Knowledge page reads it. */
export interface KnowledgePageView {
  readonly current: KnowledgePageVersion | null;
  /** Newest first. */
  readonly history: readonly KnowledgePageHistoryEntry[];
  /** When the waiting regeneration may run (the minimum interval after the last version); null when none waits. */
  readonly nextRegenerationAt: string | null;
  /** A regeneration is queued or waiting for the interval. */
  readonly pending: boolean;
  /** The last agent-set versions the page observed, newest first. */
  readonly agentSetHistory: readonly KnowledgePageAgentSetVersion[];
  /** Pin / Not key verdicts in force, newest first: the page applies them at once, and the next regeneration writes them in. */
  readonly feedback: readonly KnowledgePageFeedback[];
}

/** An agent-set version the page observed, with the agent and command files that moved with it. */
export type KnowledgePageAgentSetVersion = KnowledgePageBasis['agentSetBumps'][number];

/** The knowledge document that holds the board's rules for what is key; learnings change it like any document. */
export const KNOWLEDGE_PAGE_GUIDE_NAME = 'knowledge-page-guide';
export const KNOWLEDGE_PAGE_GUIDE_AREA = 'knowledge-page';
export const KNOWLEDGE_PAGE_GUIDE_DESCRIPTION =
  'Decides what the knowledge page shows as key decisions: the rule for which decisions a new developer or the product owner needs.';
/** The guide a board starts with (the criteria the page's prompt used before the guide existed). */
export const KNOWLEDGE_PAGE_GUIDE_SEED = `# What is key on the knowledge page

The knowledge page's Key decisions section shows the decisions a new developer or the product owner needs to work on the project.

A decision is key when it is a choice of architecture, tooling, process or product behaviour that is not obvious from the code.

A decision is not key when it is a detail of one change, a fix, a one-off instruction, or something anyone reading the code would see at once.
`;
/** The page's prompt carries at most this many characters of the guide. */
export const KNOWLEDGE_PAGE_GUIDE_MAX = 4_000;

/** A person's verdict on a decision: pin it as key, or say it is not key. */
export const KNOWLEDGE_PAGE_VERDICTS = ['pin', 'hide'] as const;
export type KnowledgePageVerdict = (typeof KNOWLEDGE_PAGE_VERDICTS)[number];

/** The page shows at most this many key decisions, pinned ones first. */
export const KNOWLEDGE_PAGE_KEY_MAX = 20;
/** The newest verdicts the prompt shows the model as examples. */
export const KNOWLEDGE_PAGE_EXAMPLES_MAX = 20;
/** Mining looks at verdicts this young. */
export const KNOWLEDGE_PAGE_FEEDBACK_DAYS = 30;
/** This many verdicts the same way about decisions with something in common raise a learning against the guide. */
export const KNOWLEDGE_PAGE_FEEDBACK_MIN = 3;

/** One verdict on a decision glob; undoing it deletes the row. */
export interface KnowledgePageFeedback {
  readonly boardId: number;
  readonly globId: string;
  readonly verdict: KnowledgePageVerdict;
  readonly by: string;
  readonly at: string;
}

/** What a verdict makes of an entry's `key`: any pin makes it key, else any "not key" makes it not; otherwise the model's. */
export const effectiveKey = (
  entry: { readonly key?: boolean; readonly modelKey?: boolean; readonly globIds?: readonly string[] },
  verdicts: ReadonlyMap<string, KnowledgePageVerdict>,
): boolean | undefined => {
  const given = (entry.globIds ?? []).flatMap((id) => verdicts.get(id) ?? []);
  if (given.includes('pin')) return true;
  if (given.includes('hide')) return false;
  return entry.modelKey ?? entry.key;
};
