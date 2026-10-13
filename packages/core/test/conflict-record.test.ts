import { describe, expect, it } from 'vitest';
import { conflictRecords } from '../src/domain/conflict-record.js';
import type { DomainEvent } from '../src/domain/events.js';

const flagged = (
  globId: string,
  at: string,
  files: string[],
  since: string | null = 's1t9',
): DomainEvent => ({
  type: 'ConflictFlagged',
  globId,
  actor: null,
  at,
  data: { base: 'main', files, since },
});
const cleared = (globId: string, at: string, data: DomainEvent['data'] = {}): DomainEvent => ({
  type: 'ConflictCleared',
  globId,
  actor: null,
  at,
  data: { base: 'main', ...data },
});

describe('conflictRecords', () => {
  it('opens one row per file and closes them with who resolved it and how', () => {
    const rows = conflictRecords([
      cleared('s1t1', '2026-10-13T02:00:00Z', {
        files: ['a.ts', 'b.ts'],
        since: 's1t9',
        by: 'run',
        kind: 'additive',
      }),
      flagged('s1t1', '2026-10-13T01:00:00Z', ['a.ts', 'b.ts']),
    ]);
    expect(rows.map((r) => [r.path, r.globId, r.since, r.resolvedAt, r.by, r.kind])).toEqual([
      ['a.ts', 's1t1', 's1t9', '2026-10-13T02:00:00Z', 'run', 'additive'],
      ['b.ts', 's1t1', 's1t9', '2026-10-13T02:00:00Z', 'run', 'additive'],
    ]);
  });

  it('leaves a conflict open until it is cleared, and keeps globs apart', () => {
    const rows = conflictRecords([
      flagged('s1t1', '2026-10-13T01:00:00Z', ['a.ts']),
      flagged('s1t2', '2026-10-13T01:05:00Z', ['a.ts'], null),
      cleared('s1t2', '2026-10-13T01:30:00Z', { files: ['a.ts'], by: 'human', kind: 'real' }),
    ]);
    expect(rows.map((r) => [r.globId, r.since, r.resolvedAt, r.by, r.kind])).toEqual([
      ['s1t1', 's1t9', null, null, null],
      ['s1t2', null, '2026-10-13T01:30:00Z', 'human', 'real'],
    ]);
  });

  it('closes every open row on an old clear event that names no files, with nothing recorded about how', () => {
    const rows = conflictRecords([
      flagged('s1t1', '2026-10-13T01:00:00Z', ['a.ts', 'b.ts']),
      cleared('s1t1', '2026-10-13T02:00:00Z'),
    ]);
    expect(rows.map((r) => [r.path, r.resolvedAt, r.by, r.kind])).toEqual([
      ['a.ts', '2026-10-13T02:00:00Z', null, null],
      ['b.ts', '2026-10-13T02:00:00Z', null, null],
    ]);
  });

  it('records a later conflict of the same file as a new row and ignores a repeat flag while open', () => {
    const rows = conflictRecords([
      flagged('s1t1', '2026-10-13T01:00:00Z', ['a.ts']),
      flagged('s1t1', '2026-10-13T01:10:00Z', ['a.ts']),
      cleared('s1t1', '2026-10-13T02:00:00Z', { files: ['a.ts'] }),
      flagged('s1t1', '2026-10-13T03:00:00Z', ['a.ts']),
    ]);
    expect(rows.map((r) => [r.flaggedAt, r.resolvedAt])).toEqual([
      ['2026-10-13T01:00:00Z', '2026-10-13T02:00:00Z'],
      ['2026-10-13T03:00:00Z', null],
    ]);
  });
});
