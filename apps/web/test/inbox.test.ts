import { describe, expect, it } from 'vitest';
import type { InboxItemView } from '../src/lib/api';
import {
  attachableGlobs,
  isInboxLink,
  newCount,
  pendingCount,
  processingNote,
  visibleItems,
} from '../src/lib/inbox';
import { activeTab, BOARD_TABS } from '../src/lib/notification-bar';

const item = (id: number, patch: Partial<InboxItemView> = {}): InboxItemView => ({
  id,
  title: `Item ${String(id)}`,
  occurredAt: '2026-10-03T00:00:00.000Z',
  status: 'new',
  ...patch,
});

describe('the inbox', () => {
  it('counts the new items and the ones still being summarised', () => {
    const items = [
      item(1),
      item(2, { status: 'kept', processing: 'waiting' }),
      item(3, { processing: 'pending' }),
      item(4, { status: 'attached', processing: 'done' }),
    ];
    expect(newCount(items)).toBe(2);
    expect(pendingCount(items)).toBe(2);
    expect(pendingCount([item(5)])).toBe(0);
  });

  it('lists everything not discarded, or only what is new', () => {
    const items = [item(1), item(2, { status: 'kept' }), item(3, { status: 'discarded' })];
    expect(visibleItems(items, false).map((i) => i.id)).toEqual([1, 2]);
    expect(visibleItems(items, true).map((i) => i.id)).toEqual([1]);
  });

  it('offers open globs the item is not on yet, in ID order', () => {
    const globs = [
      { id: 's1t10', status: 'planning' },
      { id: 's1t2', status: 'implementing' },
      { id: 's1t3', status: 'signed_off' },
      { id: 's1t4', status: 'planning' },
    ];
    expect(
      attachableGlobs(globs, { attachedTo: [{ globId: 's1t4', title: 'x' }] }).map((g) => g.id),
    ).toEqual(['s1t2', 's1t10']);
    // An older API sends no attachedTo.
    expect(attachableGlobs(globs, {}).map((g) => g.id)).toEqual(['s1t2', 's1t4', 's1t10']);
  });

  it('says what an item without a summary is waiting for', () => {
    expect(processingNote({ processing: 'pending', lastError: null })).toBe('Summarising…');
    expect(
      processingNote({
        processing: 'waiting',
        lastError: 'Waiting: Bedrock busy (retrying at 10:05 UTC)',
      }),
    ).toContain('Bedrock busy');
    expect(processingNote({ processing: 'failed', lastError: 'not usable JSON' })).toContain(
      'not usable JSON',
    );
    expect(processingNote({ processing: 'done', lastError: null })).toBeNull();
    expect(processingNote({})).toBeNull();
  });

  it('has an Inbox tab after Board, active on its route', () => {
    expect(BOARD_TABS.map((t) => t.tab).slice(0, 2)).toEqual(['board', 'inbox']);
    expect(activeTab('/boards/1/inbox', 1)).toBe('inbox');
    expect(activeTab('/boards/1/inbox/', 1)).toBe('inbox');
    expect(activeTab('/boards/1', 1)).toBe('board');
  });

  it('opens only an inbox item link in place', () => {
    expect(isInboxLink('/boards/12/inbox?item=345')).toBe(true);
    for (const link of [
      '//evil.example',
      '//evil.example/boards/1/inbox?item=2',
      '/boards/1/inbox',
      '/boards/1/inbox?item=2&x=1',
      '/boards/1/inbox?item=x',
      'https://x.test/boards/1/inbox?item=2',
      '/boards/1/settings',
    ])
      expect(isInboxLink(link)).toBe(false);
  });
});
