import { describe, expect, it } from 'vitest';
import { conflictRecords, workstreamConflictRecords } from '../src/domain/conflict-record.js';
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

const recorded = (globId: string, at: string, workstreams: { name: string; conflicts: string[] }[]): DomainEvent => ({
  type: 'WorkstreamsRecorded',
  globId,
  actor: null,
  at,
  data: { fannedOut: true, maxParallel: 2, workstreams },
});

describe('workstreamConflictRecords', () => {
  it('makes one row per workstream and file from the latest record of each glob', () => {
    const rows = workstreamConflictRecords([
      recorded('s1t1', '2026-10-13T01:00:00Z', [{ name: 'W1', conflicts: ['old.ts'] }]),
      recorded('s1t1', '2026-10-13T03:00:00Z', [
        { name: 'W1', conflicts: ['a.ts', 'a.ts'] },
        { name: 'W2', conflicts: ['a.ts', 'b.ts'] },
        { name: 'W3', conflicts: [] },
      ]),
    ]);
    expect(rows.map((r) => [r.path, r.workstream, r.globId, r.by, r.kind])).toEqual([
      ['a.ts', 'W1', 's1t1', 'run', null],
      ['a.ts', 'W2', 's1t1', 'run', null],
      ['b.ts', 'W2', 's1t1', 'run', null],
    ]);
  });

  it('joins the conflicts between globs in conflictRecords', () => {
    const rows = conflictRecords([
      recorded('s1t1', '2026-10-13T03:00:00Z', [{ name: 'W1', conflicts: ['a.ts'] }]),
      flagged('s1t2', '2026-10-13T01:00:00Z', ['a.ts']),
    ]);
    expect(rows.map((r) => [r.globId, r.workstream])).toEqual([['s1t2', undefined], ['s1t1', 'W1']]);
  });
});
