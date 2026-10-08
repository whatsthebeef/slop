import { describe, expect, it } from 'vitest';
import type { BoardNotification } from '@slop/core';
import { barView, canDismiss, moreLabel, pollInterval } from '../src/lib/notification-bar';

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
    expect(moreLabel(view?.rest.length ?? 0)).toBe('+2 more');
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
});
