import { beforeEach, describe, expect, it } from 'vitest';
import { NotificationService } from '../src/app/notification-service.js';
import { mainRedNotification, sortNotifications } from '../src/domain/notifications.js';
import type { BoardNotification, RaisedNotification } from '../src/domain/notifications.js';
import type { ReadinessItem } from '../src/domain/readiness.js';
import type { BaseChecks } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { NOW, board } from './fixtures.js';

const MEMBER = 'dev@example.com';
const LATER = '2026-10-05T13:00:00.000Z';

const raised = (patch: Partial<RaisedNotification> = {}): RaisedNotification => ({
  boardId: board.id,
  source: 'main-red',
  severity: 'critical',
  title: 'main is red',
  detail: 'Type check failed',
  ...patch,
});

describe('board notifications', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let now: string;
  let service: NotificationService;

  const list = async (email = MEMBER) => {
    const result = await service.list(email, board.id);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    now = NOW;
    service = new NotificationService({ store, notifier, clock: { now: () => now } });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: MEMBER, name: 'Dev', active: true });
      await tx.upsertMember({ boardId: board.id, email: MEMBER, role: 'dev' });
    });
  });

  it('raises a notification and tells the board', async () => {
    await service.raise(raised({ link: 'https://x/run', action: { label: 'Open the run', href: 'https://x/run' } }));
    expect(await list()).toEqual([
      {
        id: '1/main-red',
        boardId: 1,
        source: 'main-red',
        severity: 'critical',
        title: 'main is red',
        detail: 'Type check failed',
        link: 'https://x/run',
        action: { label: 'Open the run', href: 'https://x/run' },
        since: NOW,
        clears: { kind: 'condition' },
      },
    ]);
    expect(notifier.hints).toEqual([{ kind: 'board.notifications', boardId: board.id }]);
  });

  it('raising again updates it, keeping `since`, and says nothing when nothing changed', async () => {
    await service.raise(raised());
    now = LATER;
    await service.raise(raised());
    expect(notifier.hints).toHaveLength(1);
    await service.raise(raised({ detail: 'Test failed' }));
    expect(notifier.hints).toHaveLength(2);
    expect(await list()).toMatchObject([{ detail: 'Test failed', since: NOW }]);
  });

  it('clears by source, once', async () => {
    await service.raise(raised());
    await service.clear(board.id, 'main-red');
    expect(await list()).toEqual([]);
    await service.clear(board.id, 'main-red');
    expect(notifier.hints).toHaveLength(2);
  });

  it('orders the most severe first, then the oldest', async () => {
    await service.raise(raised({ source: 'a', severity: 'info' }));
    now = LATER;
    await service.raise(raised({ source: 'b', severity: 'critical' }));
    await service.raise(raised({ source: 'c', severity: 'warning' }));
    now = '2026-10-05T14:00:00.000Z';
    await service.raise(raised({ source: 'd', severity: 'warning' }));
    expect((await list()).map((n) => n.source)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('sorts by severity rank, not by name', () => {
    const n = (severity: BoardNotification['severity'], since: string, id: string): BoardNotification => ({
      id, boardId: 1, source: id, severity, title: '', detail: '', link: null, action: null, since, clears: { kind: 'condition' },
    });
    expect(sortNotifications([n('info', NOW, 'a'), n('critical', LATER, 'z'), n('warning', NOW, 'm')]).map((x) => x.id)).toEqual(['z', 'm', 'a']);
  });

  it('drops a notification once its `until` time has passed', async () => {
    await service.raise(raised({ source: 'soon', severity: 'info', clears: { kind: 'until', at: LATER } }));
    expect(await list()).toHaveLength(1);
    now = LATER;
    expect(await list()).toEqual([]);
    expect(await store.transaction((tx) => tx.getNotification('1/soon'))).toBeNull();
  });

  it('shows global notifications on every board', async () => {
    await service.raise(raised({ boardId: null, source: 'integration:github', severity: 'warning' }));
    expect(await list()).toMatchObject([{ id: 'all/integration:github', boardId: null }]);
  });

  it('dismisses only dismissible ones', async () => {
    await service.raise(raised());
    await service.raise(raised({ source: 'tip', severity: 'info', clears: { kind: 'dismissible' } }));
    const refused = await service.dismiss(MEMBER, board.id, '1/main-red');
    expect(refused.ok).toBe(false);
    expect((await list()).map((n) => n.source)).toEqual(['main-red', 'tip']);
    expect((await service.dismiss(MEMBER, board.id, '1/tip')).ok).toBe(true);
    expect((await list()).map((n) => n.source)).toEqual(['main-red']);
    const missing = await service.dismiss(MEMBER, board.id, '1/tip');
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });

  it('is for members only', async () => {
    const result = await service.list('stranger@example.com', board.id);
    expect(!result.ok && result.error.code).toBe('forbidden');
  });

  describe('main is red', () => {
    const failed: BaseChecks = {
      sha: 'm1',
      state: 'failed',
      failure: { name: 'Check', step: 'Type check', lines: ['src/a.ts(1,1): error TS1: broken'], url: 'https://x/run/1' },
      since: 's1f5',
      redAt: NOW,
      checkedAt: NOW,
    };
    const passed: BaseChecks = { sha: 'm2', state: 'passed', since: null, checkedAt: LATER };

    it('says what failed, who caused it, and that globs are waiting', () => {
      const n = mainRedNotification(1, 'main', failed);
      expect(n).toMatchObject({ severity: 'critical', title: 'main is red since s1f5 merged', link: 'https://x/run/1', clears: { kind: 'condition' } });
      expect(n?.detail).toContain('Check (Type check): src/a.ts(1,1): error TS1: broken');
      expect(n?.detail).toContain('Globs failing the same way are waiting');
    });

    it('is raised while the base is red and cleared when it is green', async () => {
      await service.syncMainRed(1, 'main', failed);
      expect(await list()).toHaveLength(1);
      await service.syncMainRed(1, 'main', failed);
      expect(notifier.hints).toHaveLength(1);
      await service.syncMainRed(1, 'main', passed);
      expect(await list()).toEqual([]);
    });

    it('raises nothing for an unchecked base', () => {
      expect(mainRedNotification(1, 'main', null)).toBeNull();
    });
  });

  describe('board setup', () => {
    const OTHER = 'other@example.com';
    const it_ = (key: ReadinessItem['key'], state: ReadinessItem['state']): ReadinessItem => ({
      key, title: key, state, detail: `${key} detail`, fix: { kind: 'settings', label: 'Board settings' }, manual: false,
    });
    const sources = async (email = MEMBER) => (await list(email)).map((n) => n.source);

    beforeEach(async () => {
      await store.transaction(async (tx) => {
        await tx.upsertUser({ email: OTHER, name: 'Other', active: true });
        await tx.upsertMember({ boardId: board.id, email: OTHER, role: 'dev' });
      });
    });

    it('raises a warning for a failing item and clears it when the item passes', async () => {
      await service.syncReadiness(board.id, [it_('repo_app', 'failing'), it_('build_doc', 'ok')]);
      expect(await list()).toMatchObject([
        { source: 'readiness:repo_app', severity: 'warning', title: 'repo_app is failing', detail: 'repo_app detail', link: '/boards/1/settings#readiness', clears: { kind: 'condition' } },
      ]);
      await service.syncReadiness(board.id, [it_('repo_app', 'ok'), it_('build_doc', 'ok')]);
      expect(await list()).toEqual([]);
    });

    it('raises one info notification for the missing items, and nothing for unknown ones', async () => {
      await service.syncReadiness(board.id, [it_('build_doc', 'missing'), it_('environments', 'missing'), it_('sub_gate', 'unknown'), it_('agent_set', 'ok')]);
      expect(await list()).toMatchObject([
        { source: 'readiness', severity: 'info', title: 'Board setup: 2 items to do', detail: 'build_doc, environments', clears: { kind: 'personal' }, items: ['build_doc', 'environments'] },
      ]);
      await service.syncReadiness(board.id, [it_('sub_gate', 'unknown')]);
      expect(await list()).toEqual([]);
    });

    it('a dismissal is per person', async () => {
      await service.syncReadiness(board.id, [it_('build_doc', 'missing')]);
      expect((await service.dismiss(MEMBER, board.id, '1/readiness')).ok).toBe(true);
      expect(await sources()).toEqual([]);
      expect(await sources(OTHER)).toEqual(['readiness']);
    });

    it('stays dismissed while the missing set shrinks and returns when it grows', async () => {
      await service.syncReadiness(board.id, [it_('build_doc', 'missing'), it_('environments', 'missing')]);
      await service.dismiss(MEMBER, board.id, '1/readiness');
      await service.syncReadiness(board.id, [it_('build_doc', 'missing'), it_('environments', 'ok')]);
      expect(await sources()).toEqual([]);
      await service.syncReadiness(board.id, [it_('build_doc', 'missing'), it_('environments', 'missing')]);
      expect(await sources()).toEqual([]);
      await service.syncReadiness(board.id, [it_('build_doc', 'missing'), it_('environments', 'missing'), it_('agent_set', 'missing')]);
      expect(await sources()).toEqual(['readiness']);
      expect(await sources(OTHER)).toEqual(['readiness']);
    });

    it('is raised afresh once everything was done in between', async () => {
      await service.syncReadiness(board.id, [it_('build_doc', 'missing')]);
      await service.dismiss(MEMBER, board.id, '1/readiness');
      await service.syncReadiness(board.id, [it_('build_doc', 'ok')]);
      await service.syncReadiness(board.id, [it_('build_doc', 'missing')]);
      expect(await sources()).toEqual(['readiness']);
    });

    it('sync is idempotent and leaves other sources alone', async () => {
      await service.syncMainRed(1, 'main', { sha: 'm1', state: 'failed', since: null, redAt: NOW, checkedAt: NOW });
      await service.syncReadiness(board.id, [it_('build_doc', 'missing')]);
      const hints = notifier.hints.length;
      await service.syncReadiness(board.id, [it_('build_doc', 'missing')]);
      expect(notifier.hints).toHaveLength(hints);
      await service.syncReadiness(board.id, []);
      expect(await sources()).toEqual(['main-red']);
    });
  });
});

