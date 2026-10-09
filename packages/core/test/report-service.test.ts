import { beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../src/app/board-service.js';
import { GlobService } from '../src/app/glob-service.js';
import type { CreateGlobInput } from '../src/app/glob-service.js';
import { ReportService } from '../src/app/report-service.js';
import type { Result } from '../src/domain/errors.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const codeOf = <T>(result: Result<T>): string => (result.ok ? 'ok' : result.error.code);

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const PO = 'po@example.com';
const STRANGER = 'stranger@example.com';
const HEADER = 'developer,period,RnD hours,maintenance hours,% RnD\r\n';

describe('ReportService', () => {
  let store: MemoryStore;
  let globs: GlobService;
  let reports: ReportService;
  let boardId: number;
  let now: string;
  let runs: number;

  const input = (patch: Partial<CreateGlobInput> = {}): CreateGlobInput => ({
    boardId,
    title: 'Work',
    summary: '',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    autoTrigger: false,
    idempotencyKey: null,
    ...patch,
  });

  beforeEach(async () => {
    store = new MemoryStore();
    const notifier = new RecordingNotifier();
    now = '2026-10-05T08:00:00.000Z';
    runs = 0;
    const clock = { now: () => now };
    const boards = new BoardService({ store, notifier });
    globs = new GlobService({
      store,
      notifier,
      clock,
      ids: { runId: () => `run-${String(++runs)}` },
      routines: { hasRoutine: () => Promise.resolve(true) },
    });
    reports = new ReportService({ store, clock, timeZone: 'UTC' });
    await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV, PO, STRANGER]) await tx.upsertUser({ email, name: email, active: true });
    });
    boardId = unwrap(await boards.create(ADMIN, { name: 'demo', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(ADMIN, boardId, DEV, 'dev'));
    unwrap(await boards.setMember(ADMIN, boardId, PO, 'po'));
  });

  /** Dev starts their own task at 10:00 and picks up the PO's feature at 13:00 (Monday 2026-10-05). */
  const workMonday = async () => {
    const task = unwrap(await globs.create(DEV, input()));
    const feature = unwrap(await globs.create(PO, input({ category: 'feature' })));
    now = '2026-10-05T10:00:00.000Z';
    unwrap(await globs.start(DEV, task.id, task.version));
    now = '2026-10-05T13:00:00.000Z';
    unwrap(await globs.pickUp(DEV, feature.id, feature.version, false));
    now = '2026-10-05T17:00:00.000Z';
    return { task, feature };
  };

  it('computes a period from the event log on demand: RnD from features, maintenance from tasks', async () => {
    await workMonday();
    expect(unwrap(await reports.report(ADMIN, boardId, '2026-10'))).toEqual({
      boardId,
      period: '2026-10',
      kind: 'month',
      timeZone: 'UTC',
      computedAt: now,
      csv: `${HEADER}dev@example.com,2026-10,4.00,3.00,57.1\r\n`,
    });
    expect(unwrap(await reports.report(ADMIN, boardId, '2026')).csv).toBe(`${HEADER}dev@example.com,2026,4.00,3.00,57.1\r\n`);
    // A running period counts up to now; a finished one up to its end.
    now = '2026-10-05T15:00:00.000Z';
    expect(unwrap(await reports.report(ADMIN, boardId, '2026-10')).csv).toBe(`${HEADER}dev@example.com,2026-10,2.00,3.00,40.0\r\n`);
    now = '2026-11-02T12:00:00.000Z';
    expect(unwrap(await reports.report(ADMIN, boardId, '2026-09')).csv).toBe(HEADER);
  });

  it('shows the time zone to members, downloads to admins only', async () => {
    expect(unwrap(await reports.overview(DEV, boardId))).toEqual({ timeZone: 'UTC', canDownload: false });
    expect(unwrap(await reports.overview(ADMIN, boardId))).toEqual({ timeZone: 'UTC', canDownload: true });
    expect(codeOf(await reports.overview(STRANGER, boardId))).toBe('forbidden');
  });

  it('refuses non-admins, malformed periods and periods that have not started', async () => {
    expect(codeOf(await reports.report(DEV, boardId, '2026-10'))).toBe('forbidden');
    expect(codeOf(await reports.report(STRANGER, boardId, '2026-10'))).toBe('forbidden');
    // Access comes before the period check: a caller who can't download gets forbidden for any period.
    expect(codeOf(await reports.report(STRANGER, boardId, '2026-13'))).toBe('forbidden');
    expect(codeOf(await reports.report(DEV, boardId, '2027'))).toBe('forbidden');
    expect(codeOf(await reports.report(ADMIN, boardId, '2026-13'))).toBe('invalid_input');
    expect(codeOf(await reports.report(ADMIN, boardId, 'last month'))).toBe('invalid_input');
    expect(codeOf(await reports.report(ADMIN, boardId, '2026-11'))).toBe('invalid_input');
    expect(codeOf(await reports.report(ADMIN, boardId, '2027'))).toBe('invalid_input');
  });

  it('leaves a deleted glob’s time out', async () => {
    const { task } = await workMonday();
    const current = unwrap(await globs.get(DEV, task.id)).glob;
    unwrap(await globs.delete(ADMIN, task.id, current.version));
    expect(unwrap(await reports.report(ADMIN, boardId, '2026-10')).csv).toBe(`${HEADER}dev@example.com,2026-10,4.00,0.00,100.0\r\n`);
  });

  it('splits a person’s hours by board: one active glob across boards, each board counting only its own globs', async () => {
    const boards = new BoardService({ store, notifier: new RecordingNotifier() });
    // PO administers the other board; ADMIN (admin of the first board) is only a dev there.
    const other = unwrap(await boards.create(PO, { name: 'other', repo: null, baseBranch: 'main', timeZone: 'UTC', environments: [] })).id;
    unwrap(await boards.setMember(PO, other, DEV, 'dev'));
    unwrap(await boards.setMember(PO, other, ADMIN, 'dev'));
    const task = unwrap(await globs.create(DEV, input()));
    const bug = unwrap(await globs.create(DEV, input({ boardId: other, category: 'bug' })));
    now = '2026-10-05T09:00:00.000Z';
    unwrap(await globs.start(DEV, task.id, task.version));
    now = '2026-10-05T12:00:00.000Z';
    // Starting the bug on the other board makes it the active glob: the task stops counting although it stays in Doing.
    unwrap(await globs.start(DEV, bug.id, bug.version));
    now = '2026-10-05T17:00:00.000Z';
    expect(unwrap(await reports.report(ADMIN, boardId, '2026-10')).csv).toBe(`${HEADER}dev@example.com,2026-10,0.00,3.00,0.0\r\n`);
    expect(unwrap(await reports.report(PO, other, '2026-10'))).toMatchObject({ boardId: other, csv: `${HEADER}dev@example.com,2026-10,0.00,5.00,0.0\r\n` });
    // Admin of the first board but only a dev on the other: sees its time zone, can't download its report.
    expect(codeOf(await reports.report(ADMIN, other, '2026-10'))).toBe('forbidden');
    expect(unwrap(await reports.overview(ADMIN, other))).toEqual({ timeZone: 'UTC', canDownload: false });
    expect(codeOf(await reports.report(STRANGER, other, '2026-10'))).toBe('forbidden');
  });

  it('keeps counting a developer who has since left the board', async () => {
    const boards = new BoardService({ store, notifier: new RecordingNotifier() });
    await workMonday();
    unwrap(await boards.removeMember(ADMIN, boardId, DEV));
    expect(unwrap(await reports.report(ADMIN, boardId, '2026-10')).csv).toBe(`${HEADER}dev@example.com,2026-10,4.00,3.00,57.1\r\n`);
  });
});
