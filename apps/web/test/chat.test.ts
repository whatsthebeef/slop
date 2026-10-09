import { describe, expect, it } from 'vitest';
import { RequestError } from '../src/lib/api';
import type { ChatCitation } from '../src/lib/api';
import { actionsFor, citedGlobs, globScope, hideSignedOff, isChatShortcut, mentionedGlobs, saveLabel, scopeLabel, scopeOf, sourceTone, stateLabel, suggestionsFor, unavailableNotice, withCiteLinks } from '../src/lib/chat';
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
    expect(scopeLabel(glob)).toBe('Glob s15f25');
    expect(scopeLabel(inbox)).toBe('Inbox item 3');
    expect(scopeLabel({ type: 'board' })).toBe('Board');
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

  const reply = (citations: ChatCitation[]) => ({ content: 'x', citations });
  const withGlob = cite({ globId: 's1t1' });

  it('offers actions by what the answer cites and where the person is', () => {
    expect(actionsFor(reply([withGlob]), { type: 'board' }, true)).toEqual(['create_glob', 'save', 'open_glob']);
    expect(actionsFor(reply([cite({})]), { type: 'board' }, true)).toEqual(['create_glob']);
    // Attach is for an open inbox item and an answer that cites a glob.
    expect(actionsFor(reply([withGlob]), { type: 'inbox', id: '3' }, true)).toEqual(['create_glob', 'attach', 'save', 'open_glob']);
    expect(actionsFor(reply([withGlob]), { type: 'inbox' }, true)).not.toContain('attach');
    // The page's own glob is a source to save against, and one to open, when the answer cites none.
    expect(actionsFor(reply([cite({})]), { type: 'glob', id: 's1t9' }, true)).toEqual(['create_glob', 'save', 'open_glob']);
    expect(citedGlobs(reply([withGlob, cite({ globId: 's1t1' })]), { type: 'glob', id: 's1t9' })).toEqual(['s1t1', 's1t9']);
    // Nothing to save or open after "I don't know".
    expect(actionsFor(reply([]), { type: 'glob', id: 's1t9' }, false)).toEqual([]);
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
