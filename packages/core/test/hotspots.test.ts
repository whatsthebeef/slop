import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { HotspotService } from '../src/app/hotspot-service.js';
import { LearningJobService } from '../src/app/learning-jobs.js';
import { MiningService } from '../src/app/mining-service.js';
import type { FileConflict } from '../src/domain/conflict-record.js';
import { DEFAULT_CONTEXT_SETTINGS } from '../src/domain/context-settings.js';
import type { Result } from '../src/domain/errors.js';
import type { DomainEvent } from '../src/domain/events.js';
import { detectHotspots, hotspotSettingsOf } from '../src/domain/hotspots.js';
import type { Glob } from '../src/domain/types.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const ADMIN = 'admin@example.com';
const NOW = '2026-10-13T12:00:00.000Z';
const day = (d: number): string => `2026-10-${String(d).padStart(2, '0')}T00:00:00.000Z`;
const settings = hotspotSettingsOf(DEFAULT_CONTEXT_SETTINGS);

const conflict = (
  path: string,
  globId: string,
  flaggedAt: string,
  kind: FileConflict['kind'] = 'additive',
): FileConflict => ({
  path,
  globId,
  since: null,
  base: 'main',
  flaggedAt,
  resolvedAt: flaggedAt,
  by: 'run',
  kind,
});

describe('detectHotspots', () => {
  it('reads the defaults: a 7-day window, 3 globs or 2 real conflicts', () => {
    expect(settings).toEqual({ windowDays: 7, minGlobs: 3, minReal: 2 });
  });

  it('lists a file conflicted on by three different globs, with its numbers', () => {
    const hot = detectHotspots(
      [
        conflict('a.ts', 's1t1', day(10)),
        conflict('a.ts', 's1t2', day(11)),
        conflict('a.ts', 's1t3', day(12), 'real'),
        conflict('b.ts', 's1t1', day(10)),
      ],
      NOW,
      settings,
    );
    expect(hot).toEqual([
      {
        path: 'a.ts',
        conflicts: 3,
        globs: ['s1t1', 's1t2', 's1t3'],
        real: 1,
        lastConflictAt: day(12),
        merges: null,
        lines: null,
      },
    ]);
  });

  it('counts globs, not conflicts: one glob conflicting repeatedly on additive changes is not enough', () => {
    const rows = [
      conflict('a.ts', 's1t1', day(9)),
      conflict('a.ts', 's1t1', day(10)),
      conflict('a.ts', 's1t2', day(11)),
    ];
    expect(detectHotspots(rows, NOW, settings)).toEqual([]);
  });

  it('weights real conflicts: two make a hotspot with only two globs, one does not', () => {
    const two = [
      conflict('a.ts', 's1t1', day(10), 'real'),
      conflict('a.ts', 's1t2', day(11), 'real'),
    ];
    expect(detectHotspots(two, NOW, settings).map((h) => h.path)).toEqual(['a.ts']);
    expect(
      detectHotspots(
        [two[0] as FileConflict, conflict('a.ts', 's1t2', day(11), 'unknown')],
        NOW,
        settings,
      ),
    ).toEqual([]);
  });

  it('clears when the window is quiet: conflicts older than the window do not count', () => {
    const rows = [
      conflict('a.ts', 's1t1', day(1)),
      conflict('a.ts', 's1t2', day(2)),
      conflict('a.ts', 's1t3', day(3)),
    ];
    expect(detectHotspots(rows, NOW, settings)).toEqual([]);
    expect(detectHotspots(rows, '2026-10-05T00:00:00.000Z', settings)).toHaveLength(1);
    // Two of the three have left the window by the 9th.
    expect(detectHotspots(rows, '2026-10-09T12:00:00.000Z', settings)).toEqual([]);
  });

  it('puts the hottest first', () => {
    const rows = [
      ...['s1t1', 's1t2', 's1t3'].map((g) => conflict('b.ts', g, day(10))),
      ...['s1t1', 's1t2', 's1t3', 's1t4'].map((g) => conflict('a.ts', g, day(10))),
    ];
    expect(detectHotspots(rows, NOW, settings).map((h) => h.path)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('hotspot service', () => {
  let store: MemoryStore;
  let boardId: number;
  let notifier: RecordingNotifier;
  const history: Record<string, string[]> = {};
  const codeView = {
    history: (_b: number, path: string) =>
      Promise.resolve(
        (history[path] ?? []).map((date) => ({
          sha: date,
          subject: '',
          date,
          globId: null,
          change: null,
        })),
      ),
    read: (_b: number, _ref: string | null, path: string) =>
      path === 'gone.ts'
        ? Promise.resolve(null)
        : Promise.resolve({
            path,
            content: '',
            startLine: 1,
            endLine: 1,
            totalLines: 1100,
            truncated: false,
            binary: false,
          }),
  };

  const flagged = (
    globId: string,
    when: string,
    files: string[],
    kind = 'additive',
  ): DomainEvent[] => [
    {
      type: 'ConflictFlagged',
      globId,
      at: when,
      actor: null,
      data: { base: 'main', files, since: null },
    },
    {
      type: 'ConflictCleared',
      globId,
      at: when,
      actor: null,
      data: { base: 'main', files, since: null, by: 'run', kind },
    },
  ];
  const seed = async (globIds: string[], events: DomainEvent[]): Promise<void> => {
    await store.transaction(async (tx) => {
      for (const id of globIds) {
        await tx.insertGlob(
          {
            id,
            boardId,
            title: id,
            summary: '',
            type: 'sub',
            category: 'task',
            status: 'reviewing',
            createdAt: day(1),
          } as unknown as Glob,
          null,
        );
      }
      await tx.appendEvents(events);
    });
  };

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    await store.transaction((tx) => tx.upsertUser({ email: ADMIN, name: ADMIN, active: true }));
    boardId = unwrap(
      await new BoardService({ store, notifier }).create(ADMIN, {
        name: 'demo',
        repo: null,
        baseBranch: 'main',
        timeZone: 'UTC',
        environments: [],
      }),
    ).id;
    history['hot.ts'] = [day(11), day(12), day(2)];
  });

  it('lists a hot file with its conflicts, globs, merges inside the window and lines', async () => {
    await seed(
      ['s1t1', 's1t2', 's1t3'],
      ['s1t1', 's1t2', 's1t3'].flatMap((g, i) =>
        flagged(g, day(10 + i), ['hot.ts', 'cool.ts'].slice(0, g === 's1t3' ? 1 : 2)),
      ),
    );
    const service = new HotspotService({ store, clock: { now: () => NOW }, codeView });
    const view = unwrap(await service.view(ADMIN, boardId));
    expect(view.windowDays).toBe(7);
    expect(view.hotspots).toMatchObject([
      { path: 'hot.ts', conflicts: 3, globs: ['s1t1', 's1t2', 's1t3'], merges: 2, lines: 1100 },
    ]);
  });

  it('leaves merges and lines empty when the code host cannot say', async () => {
    await seed(
      ['s1t1', 's1t2', 's1t3'],
      ['s1t1', 's1t2', 's1t3'].flatMap((g) => flagged(g, day(11), ['gone.ts'])),
    );
    const failing = { history: () => Promise.reject(new Error('no clone')), read: codeView.read };
    const view = await new HotspotService({
      store,
      clock: { now: () => NOW },
      codeView: failing,
    }).hotspots(boardId, NOW);
    expect(view.hotspots).toMatchObject([{ path: 'gone.ts', merges: null, lines: null }]);
  });

  it('is clear once the window is quiet', async () => {
    await seed(
      ['s1t1', 's1t2', 's1t3'],
      ['s1t1', 's1t2', 's1t3'].flatMap((g) => flagged(g, day(11), ['hot.ts'])),
    );
    const service = new HotspotService({ store, clock: { now: () => NOW }, codeView });
    expect((await service.hotspots(boardId, NOW)).hotspots).toHaveLength(1);
    expect((await service.hotspots(boardId, '2026-10-25T00:00:00.000Z')).hotspots).toEqual([]);
  });

  it('ignores a conflict that began before the window and cleared inside it', async () => {
    await seed(
      ['s1t1', 's1t2', 's1t3'],
      [
        {
          type: 'ConflictFlagged',
          globId: 's1t1',
          at: day(1),
          actor: null,
          data: { base: 'main', files: ['old.ts'], since: null },
        },
        {
          type: 'ConflictCleared',
          globId: 's1t1',
          at: day(11),
          actor: null,
          data: { base: 'main', files: ['old.ts'], by: 'run', kind: 'real' },
        },
        ...flagged('s1t2', day(11), ['old.ts']),
        ...flagged('s1t3', day(12), ['old.ts']),
      ],
    );
    const service = new HotspotService({ store, clock: { now: () => NOW } });
    expect((await service.hotspots(boardId, NOW)).hotspots).toEqual([]);
  });

  it('is for members only', async () => {
    const service = new HotspotService({ store, clock: { now: () => NOW } });
    expect((await service.view('stranger@example.com', boardId)).ok).toBe(false);
  });

  it('runs as a board job and says what is hot', async () => {
    await seed(
      ['s1t1', 's1t2', 's1t3'],
      ['s1t1', 's1t2', 's1t3'].flatMap((g) => flagged(g, day(11), ['hot.ts'])),
    );
    const hotspots = new HotspotService({ store, clock: { now: () => NOW } });
    const jobs = new LearningJobService({
      store,
      clock: { now: () => NOW },
      notifier,
      mining: new MiningService({ store, notifier }),
      hotspots,
      manifests: null,
    });
    const finished = await unwrap(await jobs.runNow(ADMIN, boardId, 'hotspots')).finished;
    expect(finished.lastResult).toEqual({
      kind: 'hotspots',
      hot: 1,
      files: [{ path: 'hot.ts', conflicts: 3, globs: 3 }],
    });
    const bare = new LearningJobService({
      store,
      clock: { now: () => NOW },
      notifier,
      mining: new MiningService({ store, notifier }),
      manifests: null,
    });
    expect((await bare.runNow(ADMIN, boardId, 'hotspots')).ok).toBe(false);
  });
});
