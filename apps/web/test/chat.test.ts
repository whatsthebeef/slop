import { describe, expect, it } from 'vitest';
import { RequestError } from '../src/lib/api';
import type { ChatCitation } from '../src/lib/api';
import { actionsFor, citedGlobs, globScope, hideSignedOff, isChatShortcut, MESSAGE_LIST, mentionedGlobs, openGlobOf, saveLabel, scopeLabel, scopeName, scopeOf, showScopeChip, sourceTone, stateLabel, suggestionsFor, unavailableNotice, WRAP_LONG, withCiteLinks } from '../src/lib/chat';
import { takeSseEvents } from '../src/lib/sse';

const cite = (patch: Partial<ChatCitation>): ChatCitation => ({
  n: 1, source: 'decision', sourceLabel: 'Decision', title: 'T', date: '2026-10-01T00:00:00.000Z', link: null, globId: null, status: 'active', supersededBy: null, ...patch,
});

describe('the chat panel helpers', () => {
  it('marks a decision current or superseded by the newer one, and leaves other sources unmarked', () => {
    expect(stateLabel(cite({}))).toBe('current');
    expect(stateLabel(cite({ status: 'superseded', supersededBy: { title: 'Newer', date: null } }))).toBe('superseded by Newer');
    expect(stateLabel(cite({ status: 'superseded' }))).toBe('superseded');
    expect(stateLabel(cite({ source: 'glob_plan' }))).toBeNull();
  });

  it('tells a busy model from an unavailable one, with the reason', () => {
    const busy = new RequestError(503, { code: 'llm_unavailable', message: 'm', reason: 'Bedrock is busy', fix: 'Retried' });
    expect(unavailableNotice(busy)).toMatch(/^The AI is busy right now/);
    expect(unavailableNotice(busy)).toContain('Bedrock is busy');
    const down = new RequestError(503, { code: 'llm_unavailable', message: 'm', reason: 'AWS sign-in expired', fix: 'Run aws sso login' });
    expect(unavailableNotice(down)).toBe('The AI is unavailable right now. (AWS sign-in expired: Run aws sso login)');
    expect(unavailableNotice(new RequestError(403, { code: 'forbidden', message: 'x' }))).toBeNull();
    expect(unavailableNotice(new Error('x'))).toBeNull();
  });
});

describe('opening the chat', () => {
  const key = (k: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => ({
    key: k, metaKey: false, ctrlKey: false, altKey: false, target: null, ...mods,
  });

  it('opens on / and on ⌘K or Ctrl+K, and on nothing else', () => {
    expect(isChatShortcut(key('/'))).toBe(true);
    expect(isChatShortcut(key('k', { metaKey: true }))).toBe(true);
    expect(isChatShortcut(key('K', { ctrlKey: true }))).toBe(true);
    expect(isChatShortcut(key('k'))).toBe(false);
    expect(isChatShortcut(key('/', { ctrlKey: true }))).toBe(false);
    expect(isChatShortcut(key('a'))).toBe(false);
  });

  it('hides Signed Off only while the chat is open on a wide screen', () => {
    expect(hideSignedOff(true, true)).toBe(true);
    expect(hideSignedOff(false, true)).toBe(false);
    expect(hideSignedOff(true, false)).toBe(false);
  });
});

describe('the scope chip', () => {
  const glob = { type: 'glob', id: 's15f25' } as const;
  const inbox = { type: 'inbox', id: '3' } as const;

  it('follows the page, stays on a pinned one, and widens to the whole board', () => {
    expect(scopeOf(glob, null, false)).toEqual(glob);
    expect(scopeOf(inbox, glob, false)).toEqual(glob);
    expect(scopeOf(inbox, glob, true)).toEqual({ type: 'board' });
    expect(scopeName(glob)).toBe('Glob s15f25');
    expect(scopeName(inbox)).toBe('Inbox item 3');
    expect(scopeName({ type: 'board' })).toBe('Board');
    expect(globScope(glob)).toBe('s15f25');
    expect(globScope(inbox)).toBeUndefined();
  });

  it('suggests questions for the page', () => {
    expect(suggestionsFor({ type: 'board' })).toContain('What changed this week?');
    expect(suggestionsFor({ ...glob, state: 'failed' })[0]).toBe('Why did this fail?');
    expect(suggestionsFor({ ...glob, state: 'merged' })[0]).toBe('What changed?');
    expect(suggestionsFor({ type: 'knowledge', id: 'build' })[0]).toBe('What evidence supports this?');
    expect(suggestionsFor(inbox)[0]).toBe('Which globs does this relate to?');
  });
});

describe('the scope chip wording', () => {
  it('is hidden for the whole board and names what a narrower scope is about', () => {
    expect(showScopeChip({ type: 'board' })).toBe(false);
    expect(showScopeChip({ type: 'glob', id: 's15f26' })).toBe(true);
    expect(scopeLabel({ type: 'glob', id: 's15f26', title: 'Fix login timeout' })).toBe('About s15f26 · Fix login timeout');
    expect(scopeLabel({ type: 'glob', id: 's15f26' })).toBe('About s15f26');
    expect(scopeLabel({ type: 'inbox', id: '3' })).toBe('About inbox item 3');
  });
});

describe('the panel never scrolls sideways', () => {
  it('wraps a long status line and keeps the message list to one column', () => {
    const line = `Used 3 steps: Searched the board's records (all time, including history, s15t52 only): 12 found ${'x'.repeat(300)}`;
    expect(line.length).toBeGreaterThan(300);
    expect(WRAP_LONG).toContain('[overflow-wrap:anywhere]');
    expect(WRAP_LONG).toContain('min-w-0');
    expect(MESSAGE_LIST).toContain('grid-cols-[minmax(0,1fr)]');
    expect(MESSAGE_LIST).toContain('overflow-x-hidden');
    expect(MESSAGE_LIST).not.toMatch(/(^| )overflow-auto/);
  });
});

describe('answers', () => {
  it('turns [n] into a chip link only for a cited source, leaving code alone', () => {
    expect(withCiteLinks('Backoff [1], also [2] and [7].', [{ n: 1 }, { n: 2 }])).toBe('Backoff [1](cite:1), also [2](cite:2) and [7].');
    expect(withCiteLinks('Use `a[1]` and\n```\nb[1]\n```\nthen [1]', [{ n: 1 }])).toBe('Use `a[1]` and\n```\nb[1]\n```\nthen [1](cite:1)');
    expect(withCiteLinks('already [link](http://x) [1](cite:1)', [{ n: 1 }])).toBe('already [link](http://x) [1](cite:1)');
  });

  it('finds the globs an answer mentions', () => {
    expect(mentionedGlobs('s15f25 replaced s15t3, see s15f25 and s1b2.')).toEqual(['s15f25', 's15t3', 's1b2']);
    expect(mentionedGlobs('nothing here')).toEqual([]);
  });

  it('colours chips by source type', () => {
    expect(sourceTone('decision')).not.toBe(sourceTone('glob_plan'));
    expect(sourceTone('local_review')).toBe(sourceTone('code_review'));
    expect(sourceTone('board_state')).toContain('muted');
  });

  const reply = (citations: ChatCitation[], actions: ('create_glob' | 'save')[] = [], content = 'x') => ({ content, citations, actions });
  const withGlob = cite({ globId: 's1t1' });

  it('offers actions only where they fit', () => {
    // Nothing under small talk or "couldn't find" (no sources), whatever the model asked for.
    expect(actionsFor(reply([], ['create_glob', 'save']), { type: 'glob', id: 's1t9' })).toEqual([]);
    // Create glob and Save come from the model; Open is derived from the sources.
    expect(actionsFor(reply([withGlob]), { type: 'board' })).toEqual(['open_glob']);
    expect(actionsFor(reply([withGlob], ['create_glob', 'save']), { type: 'board' })).toEqual(['create_glob', 'save', 'open_glob']);
    // Save needs a glob to point at.
    expect(actionsFor(reply([cite({})], ['save']), { type: 'board' })).toEqual([]);
    // Open in glob view: one glob only, or the page's own.
    expect(openGlobOf(reply([withGlob, cite({ globId: 's1t2' })]), { type: 'board' })).toBeUndefined();
    expect(openGlobOf(reply([withGlob], [], 'see s1t1'), { type: 'board' })).toBe('s1t1');
    expect(openGlobOf(reply([cite({})]), { type: 'glob', id: 's1t9' })).toBe('s1t9');
    // Attach is for an open inbox item and an answer that cites a glob.
    expect(actionsFor(reply([withGlob]), { type: 'inbox', id: '3' })).toEqual(['attach', 'open_glob']);
    expect(actionsFor(reply([withGlob]), { type: 'inbox' })).not.toContain('attach');
    expect(citedGlobs(reply([withGlob, cite({ globId: 's1t1' })]), { type: 'glob', id: 's1t9' })).toEqual(['s1t1', 's1t9']);
    expect(saveLabel({ type: 'knowledge', id: 'build' })).toBe('Propose a change');
    expect(saveLabel({ type: 'board' })).toBe('Save to knowledge');
  });
});

describe('event streams', () => {
  it('splits whole events and keeps the unfinished rest for the next chunk', () => {
    const first = takeSseEvents('event: text\ndata: {"text":"Hi"}\n\nevent: text\ndata: {"te');
    expect(first.events).toEqual([{ event: 'text', data: '{"text":"Hi"}' }]);
    const next = takeSseEvents(`${first.rest}xt":"!"}\n\n: keep-alive\n\nevent: done\r\ndata: {}\r\n\r\n`);
    expect(next.events).toEqual([
      { event: 'text', data: '{"text":"!"}' },
      { event: 'done', data: '{}' },
    ]);
    expect(next.rest).toBe('');
  });
});
