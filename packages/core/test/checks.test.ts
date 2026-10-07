import { describe, expect, it } from 'vitest';
import { checksExplanation, failureLines, failureSummary, inheritedFailure, recordBaseChecks, sameFailure, stuckHint } from '../src/index.js';
import type { BaseChecks, CheckFailure, Result, Transition } from '../src/index.js';
import * as m from '../src/domain/machine.js';
import { NOW, ctx, glob, run } from './fixtures.js';

const HEAD = 'abc1234def';
const LATER = '2026-10-05T13:00:00.000Z';

const typecheck: CheckFailure = {
  name: 'Check',
  step: 'Type check',
  lines: ["apps/server/test/kb-routes.test.ts(31,7): error TS2739: Property 'commentOnce' is missing in type"],
  url: 'https://github.com/acme/app/actions/runs/1/job/2',
};
const lint: CheckFailure = { name: 'Check', step: 'Lint', lines: ['src/a.ts: error no-unused-vars'], url: null };

const redBase = (patch: Partial<BaseChecks> = {}): BaseChecks => ({
  sha: 'm1',
  state: 'failed',
  failure: typecheck,
  since: 's1f5',
  redAt: NOW,
  checkedAt: NOW,
  ...patch,
});

const value = (result: Result<Transition>): Transition => {
  if (!result.ok) throw new Error(`Expected ok, got ${result.error.code}`);
  return result.value;
};

const open = (patch = {}) => glob({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: HEAD }, ...patch });

describe('failure lines', () => {
  it('picks the first error lines from the log tail and strips timestamps and colours', () => {
    const log = [
      '2026-10-07T10:00:00.1234567Z > pnpm typecheck',
      '2026-10-07T10:00:01.0000000Z \u001b[31mapps/server/test/a.ts(3,1): error TS2322: bad\u001b[0m',
      '2026-10-07T10:00:02.0000000Z ##[error]Process completed with exit code 2.',
    ].join('\n');
    expect(failureLines(log)).toEqual(['apps/server/test/a.ts(3,1): error TS2322: bad', 'Process completed with exit code 2.']);
  });

  it('falls back to the last lines when none look like errors, and truncates long lines', () => {
    expect(failureLines('a\nb\n\nc')).toEqual(['a', 'b', 'c']);
    expect(failureLines('x'.repeat(500))[0]).toHaveLength(240);
    expect(failureLines('')).toEqual([]);
  });

  it('summarises as name, step and first error', () => {
    expect(failureSummary(typecheck)).toBe(`Check (Type check): ${typecheck.lines[0]}`);
    expect(failureSummary({ name: 'Lint', step: 'Lint', lines: [], url: null })).toBe('Lint failed');
  });
});

describe('inherited failures', () => {
  it('the same check with the same first error is the same failure; case and spacing are ignored', () => {
    expect(sameFailure(typecheck, { ...typecheck, step: 'other', lines: [` ${typecheck.lines[0]?.toUpperCase() ?? ''} `, 'more'] })).toBe(true);
    expect(sameFailure(typecheck, lint)).toBe(false);
    expect(sameFailure({ ...typecheck, name: 'Test' }, typecheck)).toBe(false);
    // Nothing says two failures with no error line are alike.
    expect(sameFailure({ ...typecheck, lines: [] }, { ...typecheck, lines: [] })).toBe(false);
  });

  it('is inherited only from a red base failing the same way', () => {
    expect(inheritedFailure(typecheck, redBase(), 'main')).toEqual({ base: 'main', since: 's1f5' });
    expect(inheritedFailure(lint, redBase(), 'main')).toBeNull();
    expect(inheritedFailure(typecheck, redBase({ state: 'passed' }), 'main')).toBeNull();
    expect(inheritedFailure(typecheck, null, 'main')).toBeNull();
    expect(inheritedFailure(undefined, redBase(), 'main')).toBeNull();
  });
});

describe('base checks transitions', () => {
  const red = { sha: 'm1', passed: false, failure: typecheck, merged: 's1f5' };

  it('turning red names the glob whose merge did it', () => {
    const c = recordBaseChecks(null, red, NOW);
    expect(c.next).toMatchObject({ state: 'failed', since: 's1f5', redAt: NOW });
    expect(c.changed).toBe(true);
    expect(c.turnedGreen).toBe(false);
  });

  it('staying red on a newer commit keeps the glob that broke it and when', () => {
    const c = recordBaseChecks(redBase(), { ...red, sha: 'm2', merged: 's1b5' }, LATER);
    expect(c.next).toMatchObject({ sha: 'm2', since: 's1f5', redAt: NOW });
    expect(c.changed).toBe(true);
    expect(c.turnedGreen).toBe(false);
  });

  it('the same result again changes nothing', () => {
    const first = recordBaseChecks(null, red, NOW).next;
    expect(recordBaseChecks(first, red, LATER).changed).toBe(false);
  });

  it('going green is reported once', () => {
    const green = { sha: 'm3', passed: true, failure: null, merged: null };
    const c = recordBaseChecks(redBase(), green, LATER);
    expect(c).toMatchObject({ turnedGreen: true, changed: true, next: { state: 'passed', since: null } });
    expect(recordBaseChecks(c.next, { ...green, sha: 'm4' }, LATER).turnedGreen).toBe(false);
  });
});

describe('failed checks on a glob', () => {
  it('records why they failed, and that the base is red the same way', () => {
    const t = value(m.checksCompleted(open(), { sha: HEAD, passed: false, failure: typecheck, base: redBase(), baseBranch: 'main' }, ctx(null)));
    expect(t.glob.headChecks).toMatchObject({ state: 'failed', failure: typecheck, inheritedFrom: { base: 'main', since: 's1f5' } });
    expect(checksExplanation(t.glob)).toMatchObject({ inherited: true, url: typecheck.url });
    expect(checksExplanation(t.glob)?.text).toBe(`main is red (since s1f5): not this glob's change. ${failureSummary(typecheck)}`);
  });

  it("a different failure, or a green base, is the glob's own", () => {
    const own = value(m.checksCompleted(open(), { sha: HEAD, passed: false, failure: lint, base: redBase(), baseBranch: 'main' }, ctx(null))).glob;
    expect(own.headChecks?.inheritedFrom).toBeUndefined();
    expect(checksExplanation(own)).toMatchObject({ inherited: false, text: failureSummary(lint) });
    const green = value(m.checksCompleted(open(), { sha: HEAD, passed: false, failure: typecheck, base: redBase({ state: 'passed' }), baseBranch: 'main' }, ctx(null))).glob;
    expect(green.headChecks?.inheritedFrom).toBeUndefined();
  });

  it('says only that checks failed when the log could not be read, and nothing for passing checks', () => {
    const failed = value(m.checksCompleted(open(), { sha: HEAD, passed: false }, ctx(null))).glob;
    expect(checksExplanation(failed)).toMatchObject({ text: 'Checks failed', lines: [], inherited: false });
    const passed = value(m.checksCompleted(open(), { sha: HEAD, passed: true }, ctx(null))).glob;
    expect(checksExplanation(passed)).toBeNull();
  });

  it('a red base marks a glob that failed before it was known, and a fixed base unmarks it', () => {
    const failed = value(m.checksCompleted(open(), { sha: HEAD, passed: false, failure: typecheck }, ctx(null))).glob;
    const marked = value(m.baseChecksChanged(failed, { checks: redBase(), branch: 'main' }, ctx(null)));
    expect(marked.glob.headChecks?.inheritedFrom).toEqual({ base: 'main', since: 's1f5' });
    // Same result again: nothing to write.
    expect(value(m.baseChecksChanged(marked.glob, { checks: redBase(), branch: 'main' }, ctx(null))).changed).toBe(false);
    const cleared = value(m.baseChecksChanged(marked.glob, { checks: redBase({ state: 'passed' }), branch: 'main' }, ctx(null)));
    expect(cleared.glob.headChecks?.inheritedFrom).toBeUndefined();
    expect(cleared.glob.headChecks?.failure).toEqual(typecheck);
  });

  it('ignores globs without failed head checks', () => {
    expect(value(m.baseChecksChanged(open(), { checks: redBase(), branch: 'main' }, ctx(null))).changed).toBe(false);
    const stale = open({ headChecks: { sha: 'old', state: 'failed', failure: typecheck } });
    expect(value(m.baseChecksChanged(stale, { checks: redBase(), branch: 'main' }, ctx(null))).changed).toBe(false);
  });

  it('a routine is not told it is stuck on a failure that is the base branch\'s', () => {
    const at = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString();
    const watched = (headChecks: object) =>
      open({ type: 'same', headChecks, runs: [run({ state: 'watching', lastProgressAt: NOW })] });
    const own = watched({ sha: HEAD, state: 'failed', at: NOW, failure: lint });
    expect(stuckHint(own, at(20))).toMatch(/Checks failed/);
    const inherited = watched({ sha: HEAD, state: 'failed', at: NOW, failure: typecheck, inheritedFrom: { base: 'main', since: 's1f5' } });
    expect(stuckHint(inherited, at(20))).toBeNull();
  });

  it('after a failed update the merge failure names what failed', () => {
    const merging = open({ status: 'merging' });
    const t = value(m.checksCompleted(merging, { sha: HEAD, passed: false, failure: lint }, ctx(null)));
    expect(t.glob.failure?.reason).toBe(`Checks failed after updating the branch: ${failureSummary(lint)}`);
  });
});

describe('base branch green again', () => {
  const inherited = { base: 'main', since: 's1f5' };
  const failedInherited = (patch = {}) =>
    open({ headChecks: { sha: HEAD, state: 'failed', at: NOW, failure: typecheck, inheritedFrom: inherited }, ...patch });

  it('brings a glob whose failure was inherited up to date, checked against its generation and head', () => {
    const t = value(m.baseTurnedGreen(failedInherited(), ctx(null)));
    expect(t.effects).toEqual([{ kind: 'update_branch', globId: 's1t1', generation: 1, sha: HEAD }]);
  });

  it("leaves a glob whose failure is its own, or that isn't open, alone", () => {
    const own = open({ headChecks: { sha: HEAD, state: 'failed', at: NOW, failure: lint } });
    expect(value(m.baseTurnedGreen(own, ctx(null))).effects).toEqual([]);
    expect(value(m.baseTurnedGreen(failedInherited({ status: 'reviewing' }), ctx(null))).effects).toEqual([]);
    expect(value(m.baseTurnedGreen(open(), ctx(null))).effects).toEqual([]);
  });

  it('the push that updates the branch resets the checks so they run again', () => {
    const t = value(m.commitPushed(failedInherited(), { sha: 'newhead', runId: null }, ctx(null)));
    expect(t.glob.headChecks).toBeNull();
    expect(t.effects.map((e) => e.kind)).toContain('refresh_checks');
  });
});
