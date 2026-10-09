import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const source = readFileSync(
  new URL('../../../integrations/meet-notes/Code.gs', import.meta.url),
  'utf8',
);

const delivery = z.object({
  source: z.string(),
  sourceRef: z.string(),
  sourceLabel: z.string(),
  title: z.string(),
  occurredAt: z.string(),
  text: z.string(),
});

/** The script's pure functions (doc selection, titles, dates, the request body), run as plain JS outside Apps Script. */
const script = (() => {
  const context: Record<string, unknown> = {};
  runInNewContext(source, context);
  const fn = (name: string): ((...args: unknown[]) => unknown) => {
    const value = context[name];
    if (typeof value !== 'function') throw new Error(`${name} is not defined`);
    return (...args) => runInNewContext('f(...a)', { f: value, a: args }) as unknown;
  };
  return {
    isMeetNotesDoc: fn('isMeetNotesDoc'),
    meetingTitle: fn('meetingTitle'),
    meetingDate: fn('meetingDate'),
    driveQuery: fn('driveQuery'),
    windowStart: fn('windowStart'),
    buildDelivery: fn('buildDelivery'),
    inModifiedOrder: fn('inModifiedOrder'),
  };
})();

const NAME = 'Weekly sync - 2026/10/06 10:00 BST - Notes by Gemini';

describe('meet notes script', () => {
  it('picks Gemini notes docs by title or by the Meet Recordings folder', () => {
    expect(script.isMeetNotesDoc(NAME, [])).toBe(true);
    expect(script.isMeetNotesDoc('Q3 plan', [])).toBe(false);
    expect(script.isMeetNotesDoc('Q3 plan', ['Projects'])).toBe(false);
    expect(script.isMeetNotesDoc('Retro', ['Meet Recordings'])).toBe(true);
    expect(script.isMeetNotesDoc('Notes by Gemini and my edits', [])).toBe(false);
  });

  it('takes the meeting title and day from the doc title, else the creation day', () => {
    expect(script.meetingTitle(NAME)).toBe('Weekly sync');
    expect(script.meetingTitle('Retro')).toBe('Retro');
    expect(script.meetingDate(NAME, '2026-10-07T08:00:00.000Z')).toBe('2026-10-06');
    expect(script.meetingDate('Retro', '2026-10-07T08:00:00.000Z')).toBe('2026-10-07');
  });

  it('searches from a little before the last run, or two days back on the first run', () => {
    const now = Date.parse('2026-10-09T12:00:00.000Z');
    expect(script.windowStart('2026-10-09T11:50:00.000Z', now)).toBe('2026-10-09T11:45:00.000Z');
    expect(script.windowStart(null, now)).toBe('2026-10-07T11:55:00.000Z');
    expect(script.windowStart('garbage', now)).toBe('2026-10-07T11:55:00.000Z');
    expect(script.driveQuery('2026-10-09T11:45:00.000Z')).toContain("modifiedDate > '2026-10-09T11:45:00.000Z'");
  });

  it('builds the delivery with the doc ID as the source reference', () => {
    const body = delivery.parse(
      script.buildDelivery(
        { id: 'doc123', name: NAME, url: 'https://docs.google.com/document/d/doc123', createdIso: '2026-10-06T09:00:00.000Z', modifiedMs: 0 },
        '  We agreed to ship.  ',
      ),
    );
    expect(body).toMatchObject({ source: 'meet', sourceRef: 'doc123', title: 'Weekly sync', occurredAt: '2026-10-06' });
    expect(body.text).toBe('We agreed to ship.\n\nSource: https://docs.google.com/document/d/doc123');
  });

  it('cuts text over slop\'s limit and orders docs oldest first', () => {
    const body = delivery.parse(
      script.buildDelivery({ id: 'd', name: NAME, url: 'u', createdIso: '2026-10-06T00:00:00Z', modifiedMs: 0 }, 'x'.repeat(150_000)),
    );
    expect(body.text.length).toBeLessThan(100_100);
    const ordered = z.array(z.object({ id: z.string() })).parse(
      script.inModifiedOrder([
        { id: 'b', modifiedMs: 2 },
        { id: 'a', modifiedMs: 1 },
      ]),
    );
    expect(ordered.map((d) => d.id)).toEqual(['a', 'b']);
  });
});
