import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { HotspotService } from '../src/app/hotspot-service.js';
import { LearningJobService } from '../src/app/learning-jobs.js';
import { MiningService } from '../src/app/mining-service.js';
import type { FileConflict } from '../src/domain/conflict-record.js';
import { DEFAULT_CONTEXT_SETTINGS } from '../src/domain/context-settings.js';
import type { Result } from '../src/domain/errors.js';
import type { DomainEvent } from '../src/domain/events.js';
import { detectHotspots, hotspotFacts, hotspotSettingsOf } from '../src/domain/hotspots.js';
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

describe('detectHotspots with workstream conflicts', () => {
  const ws = (path: string, globId: string, workstream: string, at: string): FileConflict => ({
    ...conflict(path, globId, at),
    kind: null,
    workstream,
  });

  it('counts each workstream that conflicted on a file as a party, like a glob', () => {
    const hot = detectHotspots(
      [ws('a.ts', 's1t1', 'W1', day(10)), ws('a.ts', 's1t1', 'W2', day(10)), ws('a.ts', 's1t1', 'W3', day(10))],
      NOW,
      settings,
    );
    expect(hot.map((h) => [h.path, h.globs, h.workstreamConflicts])).toEqual([['a.ts', ['s1t1'], 3]]);
  });

  it('lists nothing below the threshold', () => {
    expect(detectHotspots([ws('a.ts', 's1t1', 'W1', day(10)), ws('a.ts', 's1t1', 'W2', day(10))], NOW, settings)).toEqual([]);
  });
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
        firstConflictAt: day(10),
        additive: 2,
        burst: false,
        merges: null,
        lines: null,
      },
    ]);
  });

  it('marks a file whose conflicts all fell within a day as a burst, and one spread over days as not', () => {
    const at = (h: number): string => `2026-10-12T${String(h).padStart(2, '0')}:00:00.000Z`;
    const burst = detectHotspots([conflict('a.ts', 's1t1', at(1)), conflict('a.ts', 's1t2', at(5)), conflict('a.ts', 's1t3', at(20))], NOW, settings);
    expect(burst.map((h) => [h.path, h.burst, h.additive])).toEqual([['a.ts', true, 3]]);
    const spread = detectHotspots([conflict('a.ts', 's1t1', day(8)), conflict('a.ts', 's1t2', day(10)), conflict('a.ts', 's1t3', day(12))], NOW, settings);
    expect(spread.map((h) => h.burst)).toEqual([false]);
  });

  it('reads one file\'s conflicts as facts: kind, who fixed it and how fast', () => {
    const rows: FileConflict[] = [
      { ...conflict('a.ts', 's1t1', day(10), 'real'), resolvedAt: '2026-10-10T00:45:00.000Z' },
      conflict('a.ts', 's1t2', day(12)),
      conflict('b.ts', 's1t3', day(11)),
    ];
    const facts = hotspotFacts('a.ts', rows, NOW, 7);
    expect(facts).toMatchObject({ path: 'a.ts', additive: 1, real: 1, burst: false, spanHours: 48 });
    expect(facts.conflicts.map((c) => [c.globId, c.kind, c.by, c.minutesToFix])).toEqual([['s1t1', 'real', 'run', 45], ['s1t2', 'additive', 'run', 0]]);
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

  it('compares commit dates as instants, not text', async () => {
    await seed(
      ['s1t1', 's1t2', 's1t3'],
      ['s1t1', 's1t2', 's1t3'].flatMap((g) => flagged(g, day(11), ['hot.ts'])),
    );
    // The window starts 2026-10-06T12:00Z: 13:00+02:00 is 11:00Z (outside) although its text sorts after the start.
    history['hot.ts'] = ['2026-10-06T13:00:00+02:00', '2026-10-06T14:00:00+00:00'];
    const view = await new HotspotService({ store, clock: { now: () => NOW }, codeView }).hotspots(
      boardId,
      NOW,
    );
    expect(view.hotspots[0]?.merges).toBe(1);
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
