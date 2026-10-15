import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import type { GroupSummary } from '@slop/core';
import { cardProgress, groupPath, holdText, movableIn, progressText, regroupNotice } from '../src/lib/group-page';

const summary = (name: string, merged: number, total: number): GroupSummary => ({ name, progress: { merged, total }, open: total - merged, counts: {}, lastActivityAt: null });

describe('group page helpers', () => {
  it('encodes the name in the path', () => {
    expect(groupPath(3, 'a b/c')).toBe('/boards/3/groups/a%20b%2Fc');
  });

  it('shows card progress only while more than one glob is open, matching names loosely', () => {
    const groups = [summary('board-chat', 3, 5), summary('solo', 0, 1), summary('done', 4, 4)];
    expect(cardProgress(groups, 'Board_Chat')).toBe('3/5');
    expect(cardProgress(groups, 'solo')).toBeNull();
    expect(cardProgress(groups, 'done')).toBeNull();
    expect(cardProgress(groups, 'missing')).toBeNull();
    expect(cardProgress(undefined, 'board-chat')).toBeNull();
    expect(progressText({ merged: 1, total: 2 })).toBe('1/2');
  });

  it('offers work globs from other groups to move in', () => {
    const globs = [
      { id: 's1t10', group: null, category: 'task', list: 'todo' },
      { id: 's1t2', group: 'other', category: 'task', list: 'doing' },
      { id: 's1t3', group: 'Mine', category: 'task', list: 'doing' },
      { id: 's1k4', group: null, category: 'decision', list: 'todo' },
      { id: 's1t5', group: null, category: 'task', list: 'signed_off' },
    ];
    expect(movableIn(globs, 'mine').map((g) => g.id)).toEqual(['s1t2', 's1t10']);
  });

  it('words a rename that left globs behind', () => {
    expect(regroupNotice({ name: 'x', moved: 1, failed: [] })).toBe('1 glob now in x');
    expect(regroupNotice({ name: 'x', moved: 2, failed: [{ id: 's1t3', message: 'busy' }] })).toBe("2 moved to x; s1t3 didn't move, try again");
  });

  it('says who holds the move and why', () => {
    expect(holdText({ move: { holder: 'you', reason: 'sign off · QA', since: null, who: 'a@b.c' }, holding: [] })).toBe('you (a@b.c): sign off · QA');
    expect(holdText({ move: { holder: 'machine', reason: '', since: null }, holding: [] })).toBe('machine');
  });
});

describe('group api calls', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ name: 'x', moved: 1, failed: [] }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('reads, renames and merges with the name encoded in the path', async () => {
    const fetchMock = stub();
    await api.group(3, 'a b/c');
    await api.renameGroup(3, 'a b/c', 'new');
    await api.mergeGroup(3, 'a b/c', 'other');
    const calls = fetchMock.mock.calls as unknown as [string, { method: string; body: string | null }][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'GET /api/boards/3/groups/a%20b%2Fc',
      'POST /api/boards/3/groups/a%20b%2Fc/rename',
      'POST /api/boards/3/groups/a%20b%2Fc/merge',
    ]);
    expect(calls[1]?.[1].body).toBe(JSON.stringify({ to: 'new' }));
    expect(calls[2]?.[1].body).toBe(JSON.stringify({ into: 'other' }));
  });
});
