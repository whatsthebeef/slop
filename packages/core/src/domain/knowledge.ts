import type { AttachmentFile } from './attachment-file.js';
import type { AtfSpecList } from './test-plan.js';
import type { ReviewStage } from './events.js';
import type { EffectCheck } from './effect-check.js';
import type { KbMergeNote, KbOutcome, KbTarget } from './kb.js';

/**
 * The board's knowledge base: documents (conventions, build commands, architecture, review
 * checklists), the agent-set files that `sstor init` writes into a checkout, the local-run spec
 * (`local_run`, `domain/local-run.ts`) and the merge policy (`merge_policy`, `domain/merge-policy.ts`).
 */
export const KNOWLEDGE_KINDS = [
  'doc',
  'agent',
  'command',
  'hook',
  'settings',
  'mcp',
  'claude_md',
  'local_run',
  'merge_policy',
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/**
 * The kinds that belong to the agent set and change its version. Not documents, and not the local-run
 * spec (delivered beside the set, never under `.claude/`) or the merge policy (read by slop itself): each is
 * versioned on its own row.
 */
export const AGENT_SET_KINDS: readonly KnowledgeKind[] = ['agent', 'command', 'hook', 'settings', 'mcp', 'claude_md'];
export const isAgentSetKind = (kind: KnowledgeKind): boolean => AGENT_SET_KINDS.includes(kind);

/** Agent-set kinds a learning (prose) can target; settings, hooks and mcp.json aren't. */
export const PROSE_KINDS: readonly KnowledgeKind[] = ['agent', 'command', 'claude_md'];

/**
 * Agent-set rows are a layer over slop's catalog (`domain/agent-set.ts`): the board's `overlay` on
 * a catalog file, or a whole `file` the board owns. Documents are always `file`.
 */
export const KNOWLEDGE_LAYERS = ['overlay', 'file'] as const;
export type KnowledgeLayer = (typeof KNOWLEDGE_LAYERS)[number];

export interface KnowledgeDoc {
  readonly boardId: number;
  readonly kind: KnowledgeKind;
  /** Documents: a short name (`build_test_lint`). Agent-set files: their path (`agents/orchestrator.md`). */
  readonly name: string;
  readonly area: string | null;
  /** The agents that must always be given this document. */
  readonly audience: readonly string[];
  readonly description: string;
  /** Overlay rows: only the board's additions; the catalog supplies the rest. */
  readonly content: string;
  readonly layer: KnowledgeLayer;
  readonly version: number;
  /** Where it came from: `catalog:<id>@<version>`, `upload`, `import`, or `edit`. */
  readonly source: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface Frontmatter {
  readonly area: string | null;
  readonly audience: readonly string[];
  readonly description: string;
  readonly catalog: string | null;
  readonly catalogVersion: number | null;
  /** The document without its frontmatter block. */
  readonly body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const parseList = (value: string): string[] =>
  value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s !== '');

const unquote = (value: string) => value.trim().replace(/^['"]|['"]$/g, '');

/**
 * Reads the small frontmatter block knowledge documents use (`key: value` lines and `[a, b]`
 * lists). Agent definitions keep their own frontmatter (`name`, `description`) and are stored as is.
 */
export const parseFrontmatter = (text: string): Frontmatter => {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    return { area: null, audience: [], description: '', catalog: null, catalogVersion: null, body: text };
  }
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const version = Number(fields.get('version'));
  return {
    area: fields.has('area') ? unquote(fields.get('area') ?? '') || null : null,
    audience: parseList(fields.get('audience') ?? ''),
    description: unquote(fields.get('description') ?? ''),
    catalog: fields.has('catalog') ? unquote(fields.get('catalog') ?? '') || null : null,
    catalogVersion: Number.isInteger(version) ? version : null,
    body: text.slice(match[0].length),
  };
};

/** Whether a text starts with a frontmatter block. */
export const hasFrontmatter = (text: string): boolean => FRONTMATTER.test(text);

/** The frontmatter block `parseFrontmatter` reads back (area, audience, description); empty without any. */
export const renderFrontmatter = (meta: {
  readonly area: string | null;
  readonly audience: readonly string[];
  readonly description: string;
}): string => {
  const lines = [
    ...(meta.area === null ? [] : [`area: ${meta.area}`]),
    ...(meta.audience.length === 0 ? [] : [`audience: [${meta.audience.join(', ')}]`]),
    ...(meta.description === '' ? [] : [`description: ${meta.description}`]),
  ];
  return lines.length === 0 ? '' : ['---', ...lines, '---', ''].join('\n');
};

/** A document's name from a file name: `.sstor/docs/build_test_lint.md` → `build_test_lint`. */
export const docName = (fileName: string): string =>
  (fileName.split('/').pop() ?? fileName).replace(/\.md$/i, '').trim();

/** The catalog entry and version a document was forked from, read from its source (`catalog:<id>@<version>`). */
export const catalogFork = (source: string): { readonly id: string; readonly version: number } | null => {
  const match = /^catalog:(.+)@(\d+)$/.exec(source);
  if (match === null) return null;
  return { id: match[1] ?? '', version: Number(match[2]) };
};

/**
 * A board document forked from a catalog entry the catalog has since moved past. Catalog KB
 * documents stay forked (no sync): the Knowledge page shows the two texts so an admin can copy
 * changes across by hand.
 */
export interface CatalogUpdate {
  readonly name: string;
  readonly catalogId: string;
  readonly forkedVersion: number;
  readonly catalogVersion: number;
  /** The board document's body and the catalog entry's, both without frontmatter. */
  readonly board: string;
  readonly catalog: string;
}

/** The board documents whose catalog entry has a newer version than the one they were forked from. */
export const catalogUpdates = (
  docs: readonly Pick<KnowledgeDoc, 'kind' | 'name' | 'source' | 'content'>[],
  entries: readonly { readonly id: string; readonly version: number; readonly content: string }[],
): CatalogUpdate[] =>
  docs.flatMap((doc) => {
    const fork = doc.kind === 'doc' ? catalogFork(doc.source) : null;
    const entry = fork === null ? undefined : entries.find((e) => e.id === fork.id);
    if (fork === null || entry === undefined || entry.version <= fork.version) return [];
    return [
      {
        name: doc.name,
        catalogId: entry.id,
        forkedVersion: fork.version,
        catalogVersion: entry.version,
        board: doc.content,
        catalog: parseFrontmatter(entry.content).body,
      },
    ];
  });

/** Maps a path inside the agent set to its kind. */
export const agentSetKind = (path: string): KnowledgeKind | null => {
  if (path.startsWith('agents/') && path.endsWith('.md')) return 'agent';
  if (path.startsWith('commands/') && path.endsWith('.md')) return 'command';
  if (path.startsWith('hooks/')) return 'hook';
  if (path === 'settings.json') return 'settings';
  if (path === 'mcp.json') return 'mcp';
  if (path === 'claude_md.md') return 'claude_md';
  return null;
};

/**
 * A KB item's decision glob also keeps its pipeline output: the `draft` (the drafted change, JSON), the `outcome` of an
 * approval (JSON) and the `effect_check` (JSON). Each is a new version when it changes; empty content means cleared.
 */
export const ARTIFACT_KINDS = [
  'plan',
  'test_plan',
  'implementation_plan',
  'postplan',
  'local_review',
  'independent_review',
  'investigation',
  'assessment',
  'draft',
  'outcome',
  'effect_check',
  'attachment',
  'rollout_script',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * What an artifact kind is for: the `payload` is what the glob is about (plan.md; a decision's proposal), a `record` is
 * what was done (served in full by `get_context`), a `special` artifact has its own place in the view and is only listed,
 * and an `attachment` is free-form material.
 */
export type ArtifactRole = 'payload' | 'record' | 'special' | 'attachment';
export const ARTIFACT_ROLE: Record<ArtifactKind, ArtifactRole> = {
  plan: 'payload',
  // The test plan beside plan.md: served in full by get_context (`testPlan`), so not listed.
  test_plan: 'record',
  implementation_plan: 'record',
  postplan: 'record',
  local_review: 'special',
  independent_review: 'special',
  investigation: 'special',
  assessment: 'special',
  draft: 'special',
  outcome: 'special',
  effect_check: 'special',
  attachment: 'attachment',
  // A rollout step's script body: listed with the glob, shown through its step.
  rollout_script: 'special',
};
export const isSpecialKind = (kind: ArtifactKind): boolean => ARTIFACT_ROLE[kind] === 'special';

export const RISK_TIERS = ['low', 'normal', 'high'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** How a local review's cycle went, as the orchestrator reports it with `put_artifact` (mined signals). */
export interface ReviewStats {
  readonly riskTier: RiskTier;
  readonly reviewRounds: number;
  readonly maxReviewRounds: number;
  /** Tester FAIL → implementer fix loops before the review. */
  readonly testFailRounds: number;
}

/** Who produced an artifact: a person, sessionator, a model with its prompt and agent-set version, or the backfill that gave an existing glob its plan.md v1. */
export interface Provenance {
  readonly by: 'human' | 'sessionator' | 'routine' | 'backfill' | 'reviewer';
  readonly actor: string;
  readonly runId: string | null;
  readonly agentSetVersion: number | null;
  /** Local reviews only, when the orchestrator passed them. */
  readonly reviewStats?: ReviewStats;
  /** Investigations and test plans: why the text could not be parsed or has problems; absent when valid. The text is stored either way. */
  readonly validation?: string;
  /** Test plans only: the parsed `atf-specs` block (absent when the plan has none), so readers don't parse again. */
  readonly atfSpecs?: AtfSpecList;
  /** Independent reviews only: what was reviewed and how many findings it kept (the card's status reads it). */
  readonly independentReview?: IndependentReviewMeta;
  /** Drafts only: the section it replaces, the target and its version it was drafted against, and the one-line why. */
  readonly draft?: DraftMeta;
  /** A learning's outcome artifact: what its approval did (or an agent's rejection). */
  readonly kbOutcome?: KbOutcome;
  /** A learning's effect-check artifact: whether the approved change worked. */
  readonly effectCheck?: EffectCheck;
  /** Evidence attachments only: the near-duplicate learning that brought it and that learning's source globs. */
  readonly evidence?: EvidenceMeta;
  /** Merge-note attachments only: the verified quotes the pipeline closed the learning on. */
  readonly mergeNote?: KbMergeNote;
}

/** A draft's section (null: append, or a new document's body), what it was made against (so a draft whose target moved since is redone), and why. */
export interface DraftMeta {
  readonly section: string | null;
  /** The target's version it was drafted against (0: the target didn't exist yet). */
  readonly targetVersion: number | null;
  readonly target: KbTarget | null;
  readonly rationale: string | null;
}

/** Where an evidence attachment came from: a learning folded into this one. */
export interface EvidenceMeta {
  readonly itemId: string;
  readonly globIds: readonly string[];
}

/** The facts about one independent review that cards and the GitHub publisher need without parsing its text. */
export interface IndependentReviewMeta {
  readonly stage: ReviewStage;
  /** The PR head when the review ran (a later push makes the review outdated). */
  readonly headSha: string | null;
  readonly findings: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  /** What the review cost in USD; absent when the model has no price or the review made no model call. */
  readonly costUsd?: number;
}

export interface Artifact {
  readonly id: number;
  readonly globId: string;
  readonly kind: ArtifactKind;
  /** Attachments: their label. Other kinds: empty. */
  readonly label: string;
  readonly version: number;
  readonly content: string;
  readonly link: string | null;
  readonly commitSha: string | null;
  readonly provenance: Provenance;
  readonly createdAt: string;
  /** File attachments only: the stored file's facts; each state change is a new version. Absent on text and link attachments. */
  readonly file?: AttachmentFile | null;
}

/** An attachment whose latest version has no text, no link and no file: it was removed (an inbox or file detach), its older versions stay as history. */
export const isClearedAttachment = (a: {
  readonly kind: string;
  readonly content: string;
  readonly link: string | null;
  readonly file?: AttachmentFile | null;
}): boolean => a.kind === 'attachment' && a.content === '' && a.link === null && (a.file ?? null) === null;

/** An artifact's latest version without its content: what cards and `get_glob` show. */
export interface ArtifactSummary {
  readonly globId: string;
  readonly kind: ArtifactKind;
  readonly label: string;
  /** The latest version. */
  readonly version: number;
  /** How many versions exist. */
  readonly versions: number;
  /** The latest version's commit SHA. */
  readonly commitSha: string | null;
  readonly createdAt: string;
  readonly by: Provenance['by'];
  readonly actor: string;
  /** Independent reviews only. */
  readonly review?: IndependentReviewMeta;
  /** File attachments only: the latest version's file facts (state, name, type, size). */
  readonly file?: Pick<AttachmentFile, 'fileName' | 'contentType' | 'size' | 'state' | 'reason'>;
}
