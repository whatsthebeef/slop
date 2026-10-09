import { field, isObject, list, parseJson } from '../app/llm-json.js';
import { hash } from '../app/text-hash.js';
import { chunkDocument, contentHash } from './chunking.js';
import type { ChunkInput } from './chunking.js';
import { BUSY_WAITING_PREFIX, LLM_WAITING_PREFIX } from './kb.js';
import type { NewChunk, NewKnowledgeItem, SourceType } from './search.js';
import type { Glob } from './types.js';

/**
 * The board inbox (spec, Inbox and ingest): text pasted in (a meeting's notes, a thread, a document) is stored once,
 * indexed as a knowledge item, summarised with up to three suggested globs, and then attached to globs, kept, or
 * discarded. The item in the search store is a projection of the row here (`itemId`), never edited on its own.
 */

/** The source types a pasted item has; the summary step may change `meeting` to another of them. */
export const INBOX_SOURCE_TYPES = [
  'meeting',
  'thread',
  'doc',
] as const satisfies readonly SourceType[];
export type InboxSourceType = (typeof INBOX_SOURCE_TYPES)[number];

export const isInboxSourceType = (value: unknown): value is InboxSourceType =>
  INBOX_SOURCE_TYPES.some((t) => t === value);

/**
 * `new`: waiting for a person; `attached`: on at least one glob; `kept`: stays indexed, on no glob; `archived`: imported
 * history, indexed and attachable but out of the live inbox; `discarded`: gone from search.
 */
export const INBOX_STATUSES = ['new', 'attached', 'kept', 'archived', 'discarded'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

/** The summary step: `pending` until summarised (or while waiting for the model), `failed` after its last attempt. */
export const INBOX_STATES = ['pending', 'done', 'failed'] as const;
export type InboxState = (typeof INBOX_STATES)[number];

/** The longest text one paste may carry (as an indexed attachment's limit). */
export const INBOX_TEXT_LIMIT = 100_000;
/** What the summary model reads. */
export const INBOX_PROMPT_LIMIT = 30_000;
/** The most globs one item is suggested for, and the most one attach call takes. */
export const MAX_SUGGESTIONS = 3;
export const MAX_ATTACH_GLOBS = 10;
const REASON_LIMIT = 300;
const TITLE_LIMIT = 120;
const SUMMARY_LIMIT = 1_200;
export const INBOX_EXCERPT_CHARS = 300;
/** How much of an attached item's text a context bundle carries. */
export const INBOX_CONTEXT_CHARS = 12_000;

export interface InboxSuggestion {
  readonly globId: string;
  readonly reason: string;
}

export interface InboxItem {
  readonly id: number;
  readonly boardId: number;
  /** As pasted; empty until the summary step writes one (display falls back to the first line). */
  readonly title: string;
  readonly text: string;
  /** Where it came from: `paste`, an integration (`meet`, `slack`) or an import (`jira`, `gdoc`). */
  readonly source: string;
  /** The source's own ID for it (a Meet doc's ID, a Slack permalink, a Jira key, a Google Doc ID): one item per board, source and ref. Empty for a paste. */
  readonly sourceRef: string;
  readonly sourceLabel: string;
  readonly sourceType: InboxSourceType;
  /** When the thing happened (the meeting's day); the paste time when not given. */
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly createdBy: string | null;
  /** Of the normalised text: a repeat paste is the same row. */
  readonly contentHash: string;
  readonly status: InboxStatus;
  readonly summary: string | null;
  readonly suggestions: readonly InboxSuggestion[];
  readonly state: InboxState;
  readonly attempts: number;
  readonly processAfter: string | null;
  readonly lastError: string | null;
  /** The search store's item; null once discarded. */
  readonly itemId: number | null;
  readonly version: number;
  readonly updatedAt: string;
}

/** An item as `add` stores it; the store fills the rest. */
export type NewInboxItem = Pick<
  InboxItem,
  | 'boardId'
  | 'title'
  | 'text'
  | 'source'
  | 'sourceRef'
  | 'sourceLabel'
  | 'sourceType'
  | 'occurredAt'
  | 'createdAt'
  | 'createdBy'
  | 'contentHash'
> & {
  readonly sourceKey?: string | null;
  /** An import starts `archived` and already summarised (`done`), so it neither floods the inbox nor spends the model. */
  readonly status?: InboxStatus;
  readonly state?: InboxState;
};

/** An item attached to a glob. */
export interface InboxLink {
  readonly inboxId: number;
  readonly globId: string;
  /** The attachment this link put on the glob. */
  readonly artifactId: number | null;
  readonly linkedBy: string | null;
  readonly linkedAt: string;
}

/** The sources an integration token may deliver from. */
export const INTEGRATION_SOURCES = ['meet'] as const;
export type IntegrationSource = (typeof INTEGRATION_SOURCES)[number];
export const isIntegrationSource = (value: unknown): value is IntegrationSource =>
  INTEGRATION_SOURCES.some((s) => s === value);
export const SOURCE_REF_LIMIT = 200;

/** The text a repeat paste is recognised by: whitespace collapsed. */
export const inboxContentHash = (text: string): string => hash(text.replace(/\s+/g, ' ').trim());

/** The sources an import delivers (`paste` is the other one). */
export const IMPORT_SOURCES = ['jira', 'gdoc'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const inboxRef = (id: number): string => `inbox:${String(id)}`;

/** Where the inbox shows one item (the target of an attachment's link and of a citation). */
export const inboxLink = (boardId: number, id: number): string =>
  `/boards/${String(boardId)}/inbox?item=${String(id)}`;

const firstLine = (text: string, max: number): string => {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The title shown and indexed: the given or written one, else the first line of the text. */
export const inboxTitle = (item: Pick<InboxItem, 'title' | 'text'>): string =>
  item.title.trim() === '' ? firstLine(item.text, 80) || 'Untitled' : item.title.trim();

/** The attachment's label on a glob. */
export const inboxLabel = (title: string): string => `From the inbox: ${title}`;

const chunkInput = (
  item: Pick<InboxItem, 'title' | 'text' | 'sourceType' | 'occurredAt'>,
): ChunkInput => ({
  sourceType: item.sourceType,
  date: item.occurredAt,
  title: inboxTitle(item),
  text: item.text,
});

/** The search item for a row: the content hash covers what is chunked and never the glob links, so linking doesn't re-chunk. */
export const inboxItemOf = (
  item: InboxItem,
  globIds: readonly string[],
  group: string | null,
): NewKnowledgeItem => ({
  boardId: item.boardId,
  sourceType: item.sourceType,
  externalRef: inboxRef(item.id),
  title: inboxTitle(item),
  occurredAt: item.occurredAt,
  authority: 'discussion',
  status: 'active',
  supersededBy: null,
  globIds,
  globGroup: group,
  externalUrl: inboxLink(item.boardId, item.id),
  contentHash: contentHash(chunkInput(item)),
  state: 'ready',
});

export const inboxChunks = (item: InboxItem): NewChunk[] => chunkDocument(chunkInput(item));

/** A suggestion is a glob on the board that is not signed off and not already attached. */
const isOpen = (glob: Glob | undefined): glob is Glob =>
  glob !== undefined && glob.status !== 'signed_off';

/** An item as the API shows it. */
export interface InboxView {
  readonly id: number;
  readonly title: string;
  readonly source: string;
  readonly sourceLabel: string;
  readonly sourceType: InboxSourceType;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly status: InboxStatus;
  readonly summary: string | null;
  /** `waiting` while the model can't be used (the item stays pending, no attempt spent). */
  readonly processing: 'pending' | 'waiting' | 'done' | 'failed';
  readonly lastError: string | null;
  /** The start of the text, for an item with no summary yet. */
  readonly excerpt: string;
  readonly suggestions: readonly {
    readonly globId: string;
    readonly title: string;
    readonly reason: string;
  }[];
  readonly attachedTo: readonly { readonly globId: string; readonly title: string }[];
}

export interface InboxDetail extends InboxView {
  readonly text: string;
}

export const inboxView = (
  item: InboxItem,
  links: readonly InboxLink[],
  globs: ReadonlyMap<string, Glob>,
): InboxView => {
  const attached = links.filter((l) => l.inboxId === item.id).map((l) => l.globId);
  const waiting =
    item.state === 'pending' &&
    item.lastError !== null &&
    (item.lastError.startsWith(LLM_WAITING_PREFIX) ||
      item.lastError.startsWith(BUSY_WAITING_PREFIX));
  return {
    id: item.id,
    title: inboxTitle(item),
    source: item.source,
    sourceLabel: item.sourceLabel,
    sourceType: item.sourceType,
    occurredAt: item.occurredAt,
    createdAt: item.createdAt,
    status: item.status,
    summary: item.summary,
    processing: waiting ? 'waiting' : item.state,
    lastError: item.state === 'done' ? null : item.lastError,
    excerpt: item.text.trim().slice(0, INBOX_EXCERPT_CHARS),
    suggestions: item.suggestions
      .filter((s) => !attached.includes(s.globId))
      .flatMap((s) => {
        const glob = globs.get(s.globId);
        return isOpen(glob) ? [{ globId: s.globId, title: glob.title, reason: s.reason }] : [];
      }),
    attachedTo: attached.flatMap((globId) => {
      const glob = globs.get(globId);
      return glob === undefined ? [] : [{ globId, title: glob.title }];
    }),
  };
};

/** One glob the summary model may choose, with what ties it to the item. */
export interface InboxCandidate {
  readonly globId: string;
  readonly title: string;
  readonly summary: string;
  /** The best matching chunk's text. */
  readonly evidence: string;
}

export interface ParsedSummary {
  readonly title: string;
  readonly kind: InboxSourceType | null;
  readonly summary: string;
  readonly suggestions: readonly InboxSuggestion[];
}

const oneLine = (value: unknown, limit: number): string => {
  const line = (typeof value === 'string' ? value : '').trim().split(/\r?\n/)[0]?.trim() ?? '';
  return line.slice(0, limit);
};

/**
 * The model's answer as a summary: null unless it is a JSON object with a non-empty summary. A suggested glob that
 * isn't among `candidates` (or is repeated) is dropped, and at most three are kept.
 */
export const parseSummary = (
  answer: string,
  candidates: ReadonlySet<string>,
): ParsedSummary | null => {
  const parsed = parseJson(answer);
  if (!isObject(parsed)) return null;
  const said = field(parsed, 'summary');
  const summary = typeof said === 'string' ? said.trim().slice(0, SUMMARY_LIMIT) : '';
  if (summary === '') return null;
  const kind = field(parsed, 'kind');
  const suggestions: InboxSuggestion[] = [];
  for (const entry of list(field(parsed, 'suggestions'))) {
    const globId = field(entry, 'globId');
    if (
      typeof globId !== 'string' ||
      !candidates.has(globId) ||
      suggestions.some((s) => s.globId === globId)
    )
      continue;
    suggestions.push({ globId, reason: oneLine(field(entry, 'reason'), REASON_LIMIT) });
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  return {
    title: oneLine(field(parsed, 'title'), TITLE_LIMIT),
    kind: isInboxSourceType(kind) ? kind : null,
    summary,
    suggestions,
  };
};

/** A narrowing for the stored `suggestions` column. */
export const isSuggestion = (value: unknown): value is InboxSuggestion =>
  typeof value === 'object' &&
  value !== null &&
  'globId' in value &&
  typeof value.globId === 'string' &&
  'reason' in value &&
  typeof value.reason === 'string';

export const suggestionsOf = (value: unknown): InboxSuggestion[] =>
  Array.isArray(value)
    ? value.flatMap((v): InboxSuggestion[] =>
        isSuggestion(v) ? [{ globId: v.globId, reason: v.reason }] : [],
      )
    : [];
