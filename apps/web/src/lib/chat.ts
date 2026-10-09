import { RequestError } from '@/lib/api';
import type { ChatCitation, ChatMessage } from '@/lib/api';
import type { PageContext } from '@/lib/page-context';

/** What the panel says when the chat model can't answer; null for any other failure (shown as its own message). */
export const unavailableNotice = (error: unknown): string | null => {
  if (!(error instanceof RequestError) || error.body.code !== 'llm_unavailable') return null;
  const reason = error.body.reason ?? '';
  const busy = /busy/i.test(reason);
  const lead = busy ? 'The AI is busy right now. Try again in a moment.' : 'The AI is unavailable right now.';
  return reason === '' ? lead : `${lead} (${reason}${error.body.fix === undefined ? '' : `: ${error.body.fix}`})`;
};

/** A superseded decision says what replaced it; a current one says so; other sources carry no state. */
export const stateLabel = (c: ChatCitation): string | null => {
  if (c.source !== 'decision') return c.status === 'legacy' ? 'legacy' : null;
  if (c.status === 'superseded') return c.supersededBy === null ? 'superseded' : `superseded by ${c.supersededBy.title}`;
  return 'current';
};

/** Widths from this up are "wide": the chat docks beside the board and Signed Off steps aside for it. */
export const WIDE_QUERY = '(min-width: 1024px)';

/** The Signed Off column is hidden while the chat is open on a wide screen, so the other three keep their width. */
export const hideSignedOff = (chatOpen: boolean, wide: boolean): boolean => chatOpen && wide;

/** `/` or ⌘K / Ctrl+K opens the chat; `/` is left alone while someone is typing. */
export const isChatShortcut = (e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }): boolean => {
  if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey) return true;
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return false;
  const el = e.target;
  if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) return true;
  return !(el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

/** The chat's scope: the page it follows, one pinned to stay put, or the whole board. */
export const scopeOf = (page: PageContext, pinned: PageContext | null, widened: boolean): PageContext => (widened ? { type: 'board' } : (pinned ?? page));

const PAGE_NAMES: Record<PageContext['type'], string> = {
  board: 'Board',
  glob: 'Glob',
  knowledge: 'Knowledge',
  inbox: 'Inbox',
  signed_off: 'Signed off',
  settings: 'Settings',
};

/** The scope chip's text: "Glob s15f25", "Inbox item 3", "Board". */
export const scopeLabel = (scope: PageContext): string => {
  if (scope.type === 'inbox' && scope.id !== undefined) return `Inbox item ${scope.id}`;
  if (scope.type === 'knowledge' && scope.id !== undefined) return `Knowledge item ${scope.id}`;
  return scope.id === undefined ? PAGE_NAMES[scope.type] : `${PAGE_NAMES[scope.type]} ${scope.id}`;
};

/** What the server's search is limited to for a scope: a glob's own records. Everything else asks the whole board. */
export const globScope = (scope: PageContext): string | undefined => (scope.type === 'glob' ? scope.id : undefined);

/** Questions worth asking on a page, first the one people most often want. */
export const suggestionsFor = (page: PageContext): string[] => {
  switch (page.type) {
    case 'glob':
      if (page.state === 'failed') return ['Why did this fail?', 'What was decided about this?', 'What should happen next?'];
      if (page.state === 'merged') return ['What changed?', 'Why was it built this way?', 'What did the review find?'];
      return ['What is this about?', 'What was decided about this?', 'What is it waiting for?'];
    case 'knowledge':
      return ['What evidence supports this?', 'Does anything contradict this?', 'Which globs does this affect?'];
    case 'inbox':
      return page.id === undefined
        ? ['Which items are waiting for a person?', 'What came in this week?']
        : ['Which globs does this relate to?', 'What decisions does this mention?'];
    case 'signed_off':
      return ['What was signed off this week?', 'What changed this week?'];
    case 'settings':
      return ['What changed in the settings or agent set lately?'];
    default:
      return ['What changed this week?', 'What is in Doing?', 'Why did we decide this board\'s current approach?'];
  }
};

export type AnswerAction = 'create_glob' | 'attach' | 'save' | 'open_glob';

/** The globs an answer cites, then the page's, in order and without repeats. */
export const citedGlobs = (message: Pick<ChatMessage, 'citations'>, page: PageContext): string[] => {
  const ids = (message.citations ?? []).flatMap((c) => (c.globId === null ? [] : [c.globId]));
  if (page.type === 'glob' && page.id !== undefined) ids.push(page.id);
  return [...new Set(ids)];
};

/**
 * The buttons under an answer. *Save to knowledge* needs a glob to point at (one the answer cites, or the page's);
 * *Attach* adds the open inbox item to the globs the answer cites; *Open in glob view* opens the first of them.
 * Create glob is always there. Nothing is offered under "I don't know".
 */
export const actionsFor = (message: Pick<ChatMessage, 'citations' | 'content'>, page: PageContext, answered: boolean): AnswerAction[] => {
  if (!answered) return page.type === 'board' ? ['create_glob'] : [];
  const globs = citedGlobs(message, page);
  const actions: AnswerAction[] = ['create_glob'];
  if (page.type === 'inbox' && page.id !== undefined && (message.citations ?? []).some((c) => c.globId !== null)) actions.push('attach');
  if (globs.length > 0) actions.push('save', 'open_glob');
  return actions;
};

/** The label of *Save to knowledge* on a page: on a knowledge item it proposes a change to it. */
export const saveLabel = (page: PageContext): string => (page.type === 'knowledge' ? 'Propose a change' : 'Save to knowledge');

/** Where each kind of source is shown in the chips: a colour per source type, as classes. */
export const sourceTone = (source: ChatCitation['source']): string => {
  switch (source) {
    case 'decision':
    case 'decision_log':
      return 'border-emerald-600/60 bg-emerald-500/10';
    case 'glob_plan':
    case 'glob_summary':
    case 'implementation_plan':
    case 'postplan':
      return 'border-sky-600/60 bg-sky-500/10';
    case 'local_review':
    case 'code_review':
    case 'change_summary':
      return 'border-amber-600/60 bg-amber-500/10';
    case 'kb_doc':
    case 'learning':
      return 'border-violet-600/60 bg-violet-500/10';
    case 'board_state':
      return 'border-foreground/40 bg-muted';
    default:
      return 'border-rose-600/60 bg-rose-500/10';
  }
};

/**
 * The answer with each `[n]` that names a cited source turned into a link the chip renderer picks up (`cite:n`).
 * A number the answer has no citation for stays as text. Code is left alone.
 */
export const withCiteLinks = (text: string, citations: readonly Pick<ChatCitation, 'n'>[]): string => {
  const known = new Set(citations.map((c) => c.n));
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\[(\d{1,3})\](?!\()/g, (whole, n: string) => (known.has(Number(n)) ? `[${n}](cite:${n})` : whole))))
    .join('');
};

/** The glob IDs an answer mentions, in order and without repeats. */
export const mentionedGlobs = (text: string): string[] => [...new Set(text.match(/\bs\d+[ftb]\d+\b/g) ?? [])];
