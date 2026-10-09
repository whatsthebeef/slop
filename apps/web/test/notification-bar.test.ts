import { describe, expect, it } from 'vitest';
import { readinessNotifications } from '@slop/core';
import type { BoardNotification, ReadinessItem } from '@slop/core';
import { activeTab, barView, canDismiss, showBoardTools, linkTarget, moreLabel, pollInterval } from '../src/lib/notification-bar';

const n = (id: string, severity: BoardNotification['severity'], since: string, clears: BoardNotification['clears'] = { kind: 'condition' }): BoardNotification => ({
  id, boardId: 1, source: id, severity, title: id, detail: '', link: null, action: null, since, clears,
});

describe('the notification bar', () => {
  it('shows nothing without notifications', () => {
    expect(barView([])).toBeNull();
  });

  it('leads with the most severe and counts the rest', () => {
    const view = barView([n('quiet', 'info', '2026-10-05T10:00:00Z'), n('red', 'critical', '2026-10-05T12:00:00Z'), n('amber', 'warning', '2026-10-05T11:00:00Z')]);
    expect(view?.lead.id).toBe('red');
    expect(view?.rest.map((x) => x.id)).toEqual(['amber', 'quiet']);
    expect(moreLabel(view?.rest.length ?? 0)).toBe('more… (2)');
  });

  it('among equals, leads with the one that began first', () => {
    expect(barView([n('b', 'warning', '2026-10-05T12:00:00Z'), n('a', 'warning', '2026-10-05T11:00:00Z')])?.lead.id).toBe('a');
  });

  it('offers dismiss only for dismissible ones', () => {
    expect(canDismiss(n('x', 'critical', 't'))).toBe(false);
    expect(canDismiss(n('x', 'info', 't', { kind: 'dismissible' }))).toBe(true);
  });

  it('polls faster while one is showing', () => {
    expect(pollInterval(true)).toBeLessThan(pollInterval(false));
  });

  it('offers dismiss for a personal notification too', () => {
    expect(canDismiss(n('x', 'info', 't', { kind: 'personal', items: [], dismissed: {} }))).toBe(true);
  });

  it('opens this app\'s own links in place and others in a new tab', () => {
    expect(linkTarget('/boards/3/settings#readiness')).toEqual({});
    expect(linkTarget('https://github.com/x/y')).toEqual({ target: '_blank' });
  });

  it('follows the route for the active tab, the board being the default', () => {
    expect(activeTab('/boards/3', 3)).toBe('board');
    expect(activeTab('/boards/3/', 3)).toBe('board');
    expect(activeTab('/boards/3/signed-off', 3)).toBe('signed-off');
    expect(activeTab('/boards/3/knowledge', 3)).toBe('knowledge');
    expect(activeTab('/boards/3/settings', 3)).toBe('settings');
  });

  it('shows New Glob and the filters on the board tab only', () => {
    expect(showBoardTools('board')).toBe(true);
    expect(showBoardTools('settings')).toBe(false);
    expect(showBoardTools('signed-off')).toBe(false);
    expect(showBoardTools('knowledge')).toBe(false);
  });

  it('puts the most important first and the rest behind the "more…" button, in order', () => {
    const view = barView([n('i', 'info', '2026-10-05T09:00:00Z'), n('w2', 'warning', '2026-10-05T11:00:00Z'), n('w1', 'warning', '2026-10-05T10:00:00Z')]);
    expect([view?.lead.id, ...(view?.rest.map((x) => x.id) ?? [])]).toEqual(['w1', 'w2', 'i']);
  });

  describe('board setup', () => {
    const item = (key: ReadinessItem['key'], title: string, state: ReadinessItem['state']): ReadinessItem => ({
      key, title, state, detail: '', fix: null, manual: false,
    });

    it('reads as one quiet line linking to the checklist', () => {
      const [raised] = readinessNotifications(3, [item('build_doc', 'Build doc', 'missing'), item('environments', 'Environments', 'missing'), item('sub_gate', 'Sub-gate workflow', 'ok')]);
      expect(raised).toMatchObject({
        severity: 'info',
        title: 'Board setup: 2 items to do',
        detail: 'Build doc, Environments',
        link: '/boards/3/settings#readiness',
        action: { label: 'Readiness checklist', href: '/boards/3/settings#readiness' },
      });
      expect(linkTarget(raised?.action?.href ?? '')).toEqual({});
    });

    it('says "1 item" for a single one', () => {
      expect(readinessNotifications(3, [item('build_doc', 'Build doc', 'missing')])[0]?.title).toBe('Board setup: 1 item to do');
    });
  });
});
