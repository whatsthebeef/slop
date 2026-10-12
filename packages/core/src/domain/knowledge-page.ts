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

/** Why a version was written: the first one, a delta on the previous, an admin's Rebuild, or a changed prompt. */
export const KNOWLEDGE_PAGE_REASONS = ['first', 'delta', 'rebuild', 'prompt'] as const;
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
}

/** An agent-set version the page observed, with the agent and command files that moved with it. */
export type KnowledgePageAgentSetVersion = KnowledgePageBasis['agentSetBumps'][number];
