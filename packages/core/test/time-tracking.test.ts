import { describe, expect, it } from 'vitest';
import type { DomainEvent, JsonValue } from '../src/domain/events.js';
import {
  currentYear,
  deriveSegments,
  isValidTimeZone,
  parsePeriod,
  periodBounds,
  previousMonth,
  previousYear,
  recentPeriods,
  reportCsv,
  reportRows,
  workingTime,
} from '../src/domain/time-tracking.js';
import type { GlobFacts, Period, ReportRow, Segment } from '../src/domain/time-tracking.js';
import type { Category, SlopType, Status } from '../src/domain/types.js';

const ANA = 'ana@example.com';
const BOB = 'bob@example.com';
const HOUR = 3_600_000;
const NO_FACTS: ReadonlyMap<string, GlobFacts> = new Map();

const at = (day: string, time: string) => `${day}T${time}:00.000Z`;
const MON = '2026-10-05';
const event = (type: DomainEvent['type'], globId: string, actor: string | null, when: string, data: { readonly [key: string]: JsonValue } = {}): DomainEvent => ({
  type,
  globId,
  actor,
  at: when,
  data,
});
const created = (globId: string, actor: string, when: string, type: SlopType, category: Category, status: Status) =>
  event('GlobCreated', globId, actor, when, { type, category, status, group: null, environment: null });
const moved = (globId: string, actor: string | null, when: string, from: Status, to: Status) =>
  event('StatusChanged', globId, actor, when, { from, to });
/** Row 6: a pick-up from planning or failed moves to in_progress, then records the pick-up. */
const pickUp = (globId: string, actor: string, when: string, from: Status = 'planning'): DomainEvent[] => [
  moved(globId, actor, when, from, 'in_progress'),
  event('PickedUp', globId, actor, when, { takeOver: false }),
];
/** A same planned by Bob at 08:00 on Monday. */
const same = (globId: string, category: Category = 'task', planner = BOB) => created(globId, planner, at(MON, '08:00'), 'same', category, 'planning');

/** Hours counted in UTC working time (or `zone`) for a person, optionally on one glob. */
const hours = (segments: readonly Segment[], person: string, globId?: string, zone = 'UTC'): number =>
  segments
    .filter((s) => s.person === person && (globId === undefined || s.globId === globId))
    .flatMap((s) => workingTime(s.from, s.to, zone))
    .reduce((sum, d) => sum + d.ms, 0) / HOUR;

describe('time tracking: the spec’s worked examples', () => {
  it('Ana picks up s1t4 at 10:00 and s1b2 at 14:00: s1t4 gets 4 h and s1b2 counts from 14:00', () => {
    const events = [
      same('s1t4'),
      same('s1b2', 'bug'),
      ...pickUp('s1t4', ANA, at(MON, '10:00')),
      ...pickUp('s1b2', ANA, at(MON, '14:00')),
    ];
    const segments = deriveSegments(events, NO_FACTS, at(MON, '17:00'));
    expect(hours(segments, ANA, 's1t4')).toBe(4);
    expect(hours(segments, ANA, 's1b2')).toBe(3);
    expect(segments.filter((s) => s.globId === 's1b2')).toEqual([
      { person: ANA, globId: 's1b2', category: 'bug', from: at(MON, '14:00'), to: at(MON, '17:00') },
    ]);
    expect(hours(segments, BOB)).toBe(0);
  });

  it('a glob entered Doing on Friday at 16:00 and merged on Monday at 10:00 counts 2 h', () => {
    const events = [
      created('s1t5', BOB, at('2026-10-08', '12:00'), 'same', 'task', 'planning'),
      moved('s1t5', BOB, at('2026-10-09', '16:00'), 'planning', 'implementing'),
      moved('s1t5', null, at('2026-10-09', '18:00'), 'implementing', 'pr_open'),
      moved('s1t5', BOB, at('2026-10-12', '09:30'), 'pr_open', 'merging'),
      event('Merged', 's1t5', null, at('2026-10-12', '10:00'), { sha: 'abc' }),
      moved('s1t5', null, at('2026-10-12', '10:00'), 'merging', 'reviewing'),
    ];
    const segments = deriveSegments(events, NO_FACTS, at('2026-10-20', '00:00'));
    expect(hours(segments, BOB)).toBe(2);
  });
});

describe('working hours', () => {
  it('excludes weekends', () => {
    expect(workingTime(at('2026-10-10', '09:00'), at('2026-10-11', '17:00'), 'UTC')).toEqual([]);
  });

  it('counts 09:00–17:00 in the configured zone, not UTC', () => {
    const total = (zone: string) => workingTime(at(MON, '13:00'), at(MON, '22:00'), zone).reduce((s, d) => s + d.ms, 0) / HOUR;
    expect(total('UTC')).toBe(4);
    expect(total('America/New_York')).toBe(8);
  });

  it('follows DST: each local day is converted on its own', () => {
    // Europe/London is on BST (UTC+1) until Sunday 2026-10-25, then GMT.
    const total = (from: string, to: string, zone: string) => workingTime(from, to, zone).reduce((s, d) => s + d.ms, 0) / HOUR;
    expect(total(at('2026-10-23', '07:00'), at('2026-10-23', '16:30'), 'Europe/London')).toBe(8);
    expect(total(at('2026-10-23', '07:00'), at('2026-10-23', '16:30'), 'UTC')).toBe(7.5);
    expect(total(at('2026-10-26', '08:00'), at('2026-10-26', '10:00'), 'Europe/London')).toBe(1);
    expect(workingTime(at('2026-10-23', '00:00'), at('2026-10-26', '23:00'), 'Europe/London')).toEqual([
      { date: '2026-10-23', ms: 8 * HOUR },
      { date: '2026-10-26', ms: 8 * HOUR },
    ]);
  });

  it('attributes time to the local date: a UTC Sunday evening is Monday morning in Auckland', () => {
    expect(workingTime(at('2026-10-04', '21:00'), at('2026-10-04', '23:00'), 'UTC')).toEqual([]);
    expect(workingTime(at('2026-10-04', '21:00'), at('2026-10-04', '23:00'), 'Pacific/Auckland')).toEqual([
      { date: '2026-10-05', ms: 2 * HOUR },
    ]);
  });

  it('is empty for an empty or reversed interval', () => {
    expect(workingTime(at(MON, '12:00'), at(MON, '12:00'), 'UTC')).toEqual([]);
    expect(workingTime(at(MON, '13:00'), at(MON, '12:00'), 'UTC')).toEqual([]);
  });

  it('knows real time zones only', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('the active glob', () => {
  it('stops counting when the glob leaves Doing', () => {
    const events = [
      same('s1t1'),
      moved('s1t1', BOB, at(MON, '10:00'), 'planning', 'implementing'),
      moved('s1t1', null, at(MON, '11:00'), 'implementing', 'pr_open'),
      moved('s1t1', BOB, at(MON, '11:30'), 'pr_open', 'merging'),
      moved('s1t1', null, at(MON, '12:00'), 'merging', 'reviewing'),
    ];
    expect(hours(deriveSegments(events, NO_FACTS, at(MON, '17:00')), BOB)).toBe(2);
  });

  it('resumes on re-entry by a person, not on a system move back into Doing', () => {
    const reentry = [
      same('s1t1'),
      moved('s1t1', BOB, at(MON, '10:00'), 'planning', 'implementing'),
      // Start again: a same goes back to Planning.
      moved('s1t1', BOB, at(MON, '11:00'), 'implementing', 'planning'),
      moved('s1t1', BOB, at(MON, '15:00'), 'planning', 'implementing'),
    ];
    expect(hours(deriveSegments(reentry, NO_FACTS, at(MON, '17:00')), BOB)).toBe(3);

    const reverted = [
      same('s1t1'),
      moved('s1t1', BOB, at(MON, '10:00'), 'planning', 'implementing'),
      moved('s1t1', null, at(MON, '12:00'), 'implementing', 'reviewing'),
      // A merge revert puts it back in failed with no actor.
      moved('s1t1', null, at(MON, '13:00'), 'reviewing', 'failed'),
    ];
    expect(hours(deriveSegments(reverted, NO_FACTS, at(MON, '17:00')), BOB)).toBe(2);
  });

  it('never resumes an older glob by itself', () => {
    const events = [
      same('s1t1'),
      same('s1t2'),
      ...pickUp('s1t1', ANA, at(MON, '10:00')),
      ...pickUp('s1t2', ANA, at(MON, '12:00')),
      moved('s1t2', null, at(MON, '14:00'), 'in_progress', 'reviewing'),
    ];
    const segments = deriveSegments(events, NO_FACTS, at(MON, '17:00'));
    expect(hours(segments, ANA, 's1t1')).toBe(2);
    expect(hours(segments, ANA, 's1t2')).toBe(2);
  });

  it('switches attribution from the planner to the implementer at pick-up', () => {
    const events = [
      created('s1t3', BOB, at(MON, '08:00'), 'sub', 'task', 'planning'),
      // Start anyway on the held sub, then Ana takes it over from the routine.
      moved('s1t3', BOB, at(MON, '10:00'), 'planning', 'implementing'),
      event('PickedUp', 's1t3', ANA, at(MON, '13:00'), { takeOver: true }),
      moved('s1t3', ANA, at(MON, '13:00'), 'implementing', 'in_progress'),
    ];
    const segments = deriveSegments(events, NO_FACTS, at(MON, '17:00'));
    expect(hours(segments, BOB)).toBe(3);
    expect(hours(segments, ANA)).toBe(4);
    expect(segments.find((s) => s.person === BOB)?.to).toBe(at(MON, '13:00'));
  });

  it('is one per person across boards', () => {
    const events = [same('s1t4'), same('s2b1', 'bug'), ...pickUp('s1t4', ANA, at(MON, '10:00')), ...pickUp('s2b1', ANA, at(MON, '11:00'))];
    const segments = deriveSegments(events, NO_FACTS, at(MON, '17:00'));
    expect(hours(segments, ANA, 's1t4')).toBe(1);
    expect(hours(segments, ANA, 's2b1')).toBe(6);
  });

  it('stops counting for the implementer when a re-trigger clears them, and gives the planner nothing', () => {
    const events = [
      created('s1t6', BOB, at(MON, '08:00'), 'sub', 'task', 'implementing'),
      moved('s1t6', null, at(MON, '09:00'), 'implementing', 'failed'),
      ...pickUp('s1t6', ANA, at(MON, '10:00'), 'failed'),
      moved('s1t6', null, at(MON, '11:00'), 'in_progress', 'failed'),
      moved('s1t6', ANA, at(MON, '12:00'), 'failed', 'implementing'),
    ];
    const segments = deriveSegments(events, NO_FACTS, at(MON, '17:00'));
    expect(hours(segments, ANA)).toBe(2);
    expect(hours(segments, BOB)).toBe(0);
  });

  it('splits a segment when the category changes', () => {
    const events = [
      same('s1f1', 'feature'),
      moved('s1f1', BOB, at(MON, '10:00'), 'planning', 'implementing'),
      event('FieldsChanged', 's1f1', BOB, at(MON, '12:00'), { category: { from: 'feature', to: 'task' } }),
    ];
    const segments = deriveSegments(events, NO_FACTS, at(MON, '17:00'));
    expect(segments.map((s) => [s.category, s.from, s.to])).toEqual([
      ['feature', at(MON, '10:00'), at(MON, '12:00')],
      ['task', at(MON, '12:00'), at(MON, '17:00')],
    ]);
  });

  it('starting someone else’s glob makes it your active glob but counts nothing', () => {
    const events = [
      same('s1t1'),
      same('s1t2'),
      ...pickUp('s1t1', ANA, at(MON, '10:00')),
      moved('s1t2', ANA, at(MON, '12:00'), 'planning', 'implementing'),
    ];
    const segments = deriveSegments(events, NO_FACTS, at(MON, '17:00'));
    expect(hours(segments, ANA)).toBe(2);
    expect(hours(segments, BOB)).toBe(0);
  });

  it('closes open segments at `until` and ignores later events', () => {
    const events = [same('s1t1'), moved('s1t1', BOB, at(MON, '10:00'), 'planning', 'implementing'), moved('s1t1', null, at(MON, '16:00'), 'implementing', 'reviewing')];
    const segments = deriveSegments(events, NO_FACTS, at(MON, '12:00'));
    expect(segments).toEqual([{ person: BOB, globId: 's1t1', category: 'task', from: at(MON, '10:00'), to: at(MON, '12:00') }]);
  });

  it('falls back to the glob row when its creation event is missing', () => {
    const facts = new Map<string, GlobFacts>([['s1t9', { planner: BOB, category: 'feature', type: 'same' }]]);
    const events = [moved('s1t9', BOB, at(MON, '10:00'), 'planning', 'implementing')];
    expect(deriveSegments(events, facts, at(MON, '17:00'))).toEqual([
      { person: BOB, globId: 's1t9', category: 'feature', from: at(MON, '10:00'), to: at(MON, '17:00') },
    ]);
    // Without either, nobody can be attributed.
    expect(deriveSegments(events, NO_FACTS, at(MON, '17:00'))).toEqual([]);
  });
});

describe('humans only', () => {
  it('a sub created straight into Doing is nobody’s active glob, and doesn’t stop the planner’s count', () => {
    const events = [
      same('s1t1'),
      moved('s1t1', BOB, at(MON, '10:00'), 'planning', 'implementing'),
      created('s1t2', BOB, at(MON, '11:00'), 'sub', 'task', 'implementing'),
    ];
    const segments = deriveSegments(events, NO_FACTS, at(MON, '17:00'));
    expect(hours(segments, BOB, 's1t1')).toBe(7);
    expect(hours(segments, BOB, 's1t2')).toBe(0);
  });

  it('a held sub released by the system counts for nobody', () => {
    const events = [
      created('s1t3', BOB, at(MON, '08:00'), 'sub', 'task', 'planning'),
      event('Released', 's1t3', null, at(MON, '10:00'), { after: ['s1t1'] }),
      moved('s1t3', null, at(MON, '10:00'), 'planning', 'implementing'),
    ];
    expect(deriveSegments(events, NO_FACTS, at(MON, '17:00'))).toEqual([]);
  });

  it('creating a super straight into Doing makes it the creator’s active glob', () => {
    const events = [created('s1f2', BOB, at(MON, '10:00'), 'super', 'feature', 'in_progress')];
    const segments = deriveSegments(events, NO_FACTS, at(MON, '17:00'));
    expect(hours(segments, BOB, 's1f2')).toBe(7);
    expect(segments[0]?.category).toBe('feature');
  });
});

describe('periods', () => {
  it('parses months and years and refuses anything else', () => {
    expect(parsePeriod('2026-10')).toEqual({ kind: 'month', key: '2026-10', year: 2026, month: 10 });
    expect(parsePeriod('2026')).toEqual({ kind: 'year', key: '2026', year: 2026 });
    for (const bad of ['2026-13', '2026-00', '26-10', '2026-1', '1999', '2026-10-01', '']) expect(parsePeriod(bad)).toBeNull();
  });

  it('bounds a period by local midnights', () => {
    const month = parsePeriod('2026-10');
    if (month === null) throw new Error('unparsed');
    expect(periodBounds(month, 'UTC')).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
    expect(periodBounds(month, 'Europe/London')).toEqual({ from: '2026-09-30T23:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
    const december: Period = { kind: 'month', key: '2026-12', year: 2026, month: 12 };
    expect(periodBounds(december, 'UTC').to).toBe('2027-01-01T00:00:00.000Z');
  });

  it('finds the previous month and the current and previous year in the zone', () => {
    expect(previousMonth('2026-10-09T12:00:00.000Z', 'UTC').key).toBe('2026-09');
    expect(previousMonth('2026-01-15T12:00:00.000Z', 'UTC').key).toBe('2025-12');
    // 23:30 UTC on 31 October is already 1 November in Auckland.
    expect(previousMonth('2026-10-31T23:30:00.000Z', 'Pacific/Auckland').key).toBe('2026-10');
    expect(currentYear('2026-12-31T23:30:00.000Z', 'Pacific/Auckland').key).toBe('2027');
    expect(previousYear('2026-10-09T12:00:00.000Z', 'UTC').key).toBe('2025');
  });

  it('offers the current month, the 12 before it and the current and previous year', () => {
    expect(recentPeriods('2026-02-09T12:00:00.000Z', 'UTC').map((p) => p.key)).toEqual([
      '2026-02', '2026-01', '2025-12', '2025-11', '2025-10', '2025-09', '2025-08', '2025-07', '2025-06', '2025-05', '2025-04', '2025-03', '2025-02',
      '2026', '2025',
    ]);
    expect(recentPeriods('2026-12-31T23:30:00.000Z', 'Pacific/Auckland', 1).map((p) => p.key)).toEqual(['2027-01', '2026-12', '2027', '2026']);
  });
});

describe('reports', () => {
  const seg = (person: string, category: Category, from: string, to: string, globId = 's1t1'): Segment => ({ person, globId, category, from, to });
  const october = parsePeriod('2026-10');
  if (october === null) throw new Error('unparsed');

  it('splits RnD (features) from maintenance (tasks and bugs) per developer, sorted, zero-hour developers left out', () => {
    const rows = reportRows(
      [
        seg(BOB, 'feature', at(MON, '09:00'), at(MON, '11:00')),
        seg(BOB, 'task', at(MON, '11:00'), at(MON, '12:00')),
        seg(ANA, 'bug', at(MON, '13:00'), at(MON, '14:00')),
        seg('weekend@example.com', 'feature', at('2026-10-10', '09:00'), at('2026-10-10', '12:00')),
      ],
      october,
      'UTC',
    );
    expect(rows).toEqual([
      { developer: ANA, period: '2026-10', rndMs: 0, maintenanceMs: HOUR },
      { developer: BOB, period: '2026-10', rndMs: 2 * HOUR, maintenanceMs: HOUR },
    ]);
  });

  it('counts only the period’s own local dates', () => {
    const segments = [seg(BOB, 'task', at('2026-09-30', '16:00'), at('2026-10-01', '10:00'))];
    const september = parsePeriod('2026-09');
    const year = parsePeriod('2026');
    if (september === null || year === null) throw new Error('unparsed');
    expect(reportRows(segments, september, 'UTC').map((r) => r.maintenanceMs)).toEqual([HOUR]);
    expect(reportRows(segments, october, 'UTC').map((r) => r.maintenanceMs)).toEqual([HOUR]);
    expect(reportRows(segments, year, 'UTC').map((r) => r.maintenanceMs)).toEqual([2 * HOUR]);
  });

  it('writes the spec’s columns with hours to 2 decimals and % RnD to 1 from unrounded totals', () => {
    const row = (developer: string, rndMs: number, maintenanceMs: number): ReportRow => ({ developer, period: '2026-10', rndMs, maintenanceMs });
    expect(
      reportCsv([
        row('a@example.com', HOUR, 2 * HOUR),
        row('b@example.com', 2 * HOUR, HOUR),
        row('c@example.com', 20 * 60_000, 0),
        row('d@example.com', 0, 3 * HOUR),
      ]),
    ).toBe(
      'developer,period,RnD hours,maintenance hours,% RnD\r\n' +
        'a@example.com,2026-10,1.00,2.00,33.3\r\n' +
        'b@example.com,2026-10,2.00,1.00,66.7\r\n' +
        'c@example.com,2026-10,0.33,0.00,100.0\r\n' +
        'd@example.com,2026-10,0.00,3.00,0.0\r\n',
    );
  });

  it('is header-only when nobody has hours, and quotes and defuses awkward values', () => {
    expect(reportCsv([])).toBe('developer,period,RnD hours,maintenance hours,% RnD\r\n');
    expect(reportCsv([{ developer: 'Smith, "J"', period: '2026', rndMs: HOUR, maintenanceMs: 0 }])).toContain('"Smith, ""J""",2026,');
    expect(reportCsv([{ developer: '=cmd()', period: '2026', rndMs: HOUR, maintenanceMs: 0 }])).toContain("\r\n'=cmd(),2026,");
    // A leading tab or carriage return is defused too (OWASP CSV injection); the CR also makes the field quoted.
    expect(reportCsv([{ developer: '\t=cmd()', period: '2026', rndMs: HOUR, maintenanceMs: 0 }])).toContain("\r\n'\t=cmd(),2026,");
    expect(reportCsv([{ developer: '\r=cmd()', period: '2026', rndMs: HOUR, maintenanceMs: 0 }])).toContain('\r\n"\'\r=cmd()",2026,');
  });
});

describe('edge cases', () => {
  const total = (from: string, to: string, zone: string) => workingTime(from, to, zone).reduce((s, d) => s + d.ms, 0) / HOUR;
  const october = parsePeriod('2026-10');
  const september = parsePeriod('2026-09');
  const july = parsePeriod('2026-07');
  const august = parsePeriod('2026-08');
  if (october === null || september === null || july === null || august === null) throw new Error('unparsed');

  it('treats 09:00 as the first and 17:00 as the end of the working day', () => {
    expect(total(at(MON, '09:00'), at(MON, '17:00'), 'UTC')).toBe(8);
    expect(total(at(MON, '17:00'), at(MON, '23:59'), 'UTC')).toBe(0);
    expect(total(at(MON, '00:00'), at(MON, '09:00'), 'UTC')).toBe(0);
    // An event exactly at 17:00 that moves the glob on stops nothing that still counted.
    const events = [same('s1t1'), moved('s1t1', BOB, at(MON, '09:00'), 'planning', 'implementing'), moved('s1t1', null, at(MON, '17:00'), 'implementing', 'reviewing')];
    expect(hours(deriveSegments(events, NO_FACTS, at('2026-10-06', '17:00')), BOB)).toBe(8);
  });

  it('puts an interval spanning a UTC month boundary in the local month (Auckland, NZDT UTC+13)', () => {
    // 20:00–23:00 UTC on 30 September is 09:00–12:00 on Thursday 1 October in Auckland.
    const segments: Segment[] = [{ person: BOB, globId: 's1t1', category: 'task', from: at('2026-09-30', '20:00'), to: at('2026-09-30', '23:00') }];
    expect(reportRows(segments, september, 'Pacific/Auckland')).toEqual([]);
    expect(reportRows(segments, october, 'Pacific/Auckland')).toEqual([{ developer: BOB, period: '2026-10', rndMs: 0, maintenanceMs: 3 * HOUR }]);
  });

  it('keeps a local afternoon that is already the next UTC month in the local month (Los Angeles, PDT UTC-7)', () => {
    // Friday 31 July 13:00–17:00 local is 20:00 UTC to 00:00 UTC on 1 August.
    const segments: Segment[] = [{ person: BOB, globId: 's1f1', category: 'feature', from: '2026-07-31T20:00:00.000Z', to: '2026-08-01T03:00:00.000Z' }];
    expect(reportRows(segments, july, 'America/Los_Angeles')).toEqual([{ developer: BOB, period: '2026-07', rndMs: 4 * HOUR, maintenanceMs: 0 }]);
    expect(reportRows(segments, august, 'America/Los_Angeles')).toEqual([]);
  });

  it('handles a DST gap at midnight on a working day (Cairo, Friday 24 April 2026)', () => {
    // Clocks jump from 00:00 to 01:00; the working day is still 09:00–17:00 EEST (06:00–14:00 UTC).
    expect(workingTime('2026-04-23T12:00:00.000Z', '2026-04-24T23:00:00.000Z', 'Africa/Cairo')).toEqual([
      { date: '2026-04-23', ms: 3 * HOUR }, // Thursday 14:00–17:00 EET
      { date: '2026-04-24', ms: 8 * HOUR },
    ]);
    expect(total('2026-04-24T05:00:00.000Z', '2026-04-24T07:00:00.000Z', 'Africa/Cairo')).toBe(1);
  });

  it('handles a DST overlap at midnight between working days (Cairo, Thursday 29 October 2026)', () => {
    // Thursday 09:00–17:00 EEST is 06:00–14:00 UTC; Friday 09:00–17:00 EET is 07:00–15:00 UTC.
    expect(workingTime('2026-10-29T00:00:00.000Z', '2026-10-30T23:00:00.000Z', 'Africa/Cairo')).toEqual([
      { date: '2026-10-29', ms: 8 * HOUR },
      { date: '2026-10-30', ms: 8 * HOUR },
    ]);
    expect(total('2026-10-29T13:00:00.000Z', '2026-10-29T15:00:00.000Z', 'Africa/Cairo')).toBe(1);
    expect(total('2026-10-30T06:00:00.000Z', '2026-10-30T08:00:00.000Z', 'Africa/Cairo')).toBe(1);
  });

  it('uses the new offset on the Monday after London springs forward', () => {
    // Sunday 29 March 2026 is the change; Monday 09:00 BST is 08:00 UTC.
    expect(workingTime('2026-03-27T00:00:00.000Z', '2026-03-30T23:00:00.000Z', 'Europe/London')).toEqual([
      { date: '2026-03-27', ms: 8 * HOUR },
      { date: '2026-03-30', ms: 8 * HOUR },
    ]);
    expect(total('2026-03-30T07:00:00.000Z', '2026-03-30T09:00:00.000Z', 'Europe/London')).toBe(1);
  });

  it('bounds a year by local midnight in a zone with a midnight DST gap (Santiago)', () => {
    // Santiago skips 00:00–01:00 on Sunday 6 September; 1 January is CLST (UTC-3) either side.
    const year = parsePeriod('2026');
    if (year === null) throw new Error('unparsed');
    expect(periodBounds(year, 'America/Santiago')).toEqual({ from: '2026-01-01T03:00:00.000Z', to: '2027-01-01T03:00:00.000Z' });
  });

  it('resumes an older glob when it is picked up again after another', () => {
    const events = [
      same('s1t1'),
      same('s1t2'),
      ...pickUp('s1t1', ANA, at(MON, '09:00')),
      ...pickUp('s1t2', ANA, at(MON, '11:00')),
      event('PickedUp', 's1t1', ANA, at(MON, '15:00'), { takeOver: false }),
    ];
    const segments = deriveSegments(events, NO_FACTS, at(MON, '17:00'));
    expect(hours(segments, ANA, 's1t1')).toBe(4);
    expect(hours(segments, ANA, 's1t2')).toBe(4);
  });

  it('gives the planner nothing when the system (null actor) moves their glob into Doing', () => {
    const events = [
      same('s1t1'),
      created('s1t2', BOB, at(MON, '09:00'), 'same', 'task', 'planning'),
      moved('s1t2', null, at(MON, '10:00'), 'planning', 'implementing'),
    ];
    expect(deriveSegments(events, NO_FACTS, at(MON, '17:00'))).toEqual([]);
  });

  it('writes a header-only CSV when every segment is outside working hours (no 0/0 % RnD)', () => {
    const segments: Segment[] = [
      { person: BOB, globId: 's1t1', category: 'feature', from: at(MON, '17:00'), to: at('2026-10-06', '09:00') },
      { person: ANA, globId: 's1t2', category: 'bug', from: at('2026-10-10', '09:00'), to: at('2026-10-11', '17:00') },
    ];
    const rows = reportRows(segments, october, 'UTC');
    expect(rows).toEqual([]);
    expect(reportCsv(rows)).toBe('developer,period,RnD hours,maintenance hours,% RnD\r\n');
  });

  it('rounds % RnD to 1 decimal from unrounded totals', () => {
    // 1 h RnD of 6 h = 16.666… → 16.7; 1 of 8 = 12.5 → 12.5 exactly.
    const csv = reportCsv([
      { developer: 'a@example.com', period: '2026-10', rndMs: HOUR, maintenanceMs: 5 * HOUR },
      { developer: 'b@example.com', period: '2026-10', rndMs: HOUR, maintenanceMs: 7 * HOUR },
    ]);
    expect(csv).toContain('a@example.com,2026-10,1.00,5.00,16.7\r\n');
    expect(csv).toContain('b@example.com,2026-10,1.00,7.00,12.5\r\n');
  });

  it('defuses a leading + or - or @ as well as =', () => {
    for (const developer of ['+1', '-x', '@sum']) {
      expect(reportCsv([{ developer, period: '2026', rndMs: HOUR, maintenanceMs: 0 }])).toContain(`\r\n'${developer},2026,`);
    }
  });

  it('splits a category change mid-period into RnD and maintenance in the report', () => {
    const events = [
      same('s1f1', 'feature'),
      moved('s1f1', BOB, at(MON, '09:00'), 'planning', 'implementing'),
      event('FieldsChanged', 's1f1', BOB, at(MON, '12:00'), { category: { from: 'feature', to: 'bug' } }),
    ];
    const rows = reportRows(deriveSegments(events, NO_FACTS, at(MON, '17:00')), october, 'UTC');
    expect(rows).toEqual([{ developer: BOB, period: '2026-10', rndMs: 3 * HOUR, maintenanceMs: 5 * HOUR }]);
    expect(reportCsv(rows)).toBe('developer,period,RnD hours,maintenance hours,% RnD\r\nbob@example.com,2026-10,3.00,5.00,37.5\r\n');
  });
});
