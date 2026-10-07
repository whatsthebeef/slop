import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../src/domain/events.js';
import type { FindingClass, FindingSeverity, FindingSource, ReviewFinding } from '../src/domain/findings.js';
import { addedDependencies, isManifestPath } from '../src/domain/manifests.js';
import {
  globAgentSetVersion,
  lineChange,
  measureSignals,
  normaliseFailure,
  perGlob,
  reviewRounds,
  sameCommit,
  SIGNALS,
  supersededCause,
} from '../src/domain/signals.js';
import type { ArtifactMeta, BoardActivity, Measurement } from '../src/domain/signals.js';
import type { ReviewStats } from '../src/domain/knowledge.js';
import type { SlopType } from '../src/domain/types.js';

const AT = '2026-10-01T12:00:00.000Z';

const event = (globId: string, type: DomainEvent['type'], data: DomainEvent['data'] = {}, at = AT): DomainEvent => ({
  type,
  globId,
  actor: null,
  at,
  data,
});

let artifactId = 0;
const artifact = (globId: string, kind: ArtifactMeta['kind'], patch: Partial<ArtifactMeta> & { reviewStats?: ReviewStats } = {}): ArtifactMeta => {
  const { reviewStats, ...rest } = patch;
  return {
    id: ++artifactId,
    globId,
    kind,
    label: '',
    version: 1,
    commitSha: null,
    provenance: { by: 'sessionator', actor: 'dev@example.com', runId: null, agentSetVersion: null, ...(reviewStats !== undefined && { reviewStats }) },
    createdAt: AT,
    content: kind === 'local_review' || kind === 'implementation_plan' ? '' : null,
    ...rest,
  };
};

let findingId = 0;
const finding = (
  globId: string,
  cls: FindingClass | null,
  patch: { severity?: FindingSeverity; source?: FindingSource; commitSha?: string | null; text?: string } = {},
): ReviewFinding => ({
  id: ++findingId,
  boardId: 1,
  globId,
  sourceId: 1,
  source: patch.source ?? 'local_review',
  commitSha: patch.commitSha ?? null,
  agentSetVersion: null,
  severity: patch.severity ?? 'in_scope',
  round: null,
  path: null,
  line: null,
  text: patch.text ?? `A ${cls ?? 'pending'} finding on ${globId}`,
  fingerprint: `f${String(findingId)}`,
  class: cls,
  classNote: null,
  state: cls === null ? 'pending' : 'classified',
  attempts: 0,
  processAfter: null,
  error: null,
  createdAt: AT,
  classifiedAt: cls === null ? null : AT,
  version: 1,
});

const activity = (patch: Partial<BoardActivity> = {}, types: Record<string, SlopType> = {}): BoardActivity => {
  const ids = new Set<string>([
    ...(patch.events ?? []).map((e) => e.globId),
    ...(patch.artifacts ?? []).map((a) => a.globId),
    ...(patch.findings ?? []).map((f) => f.globId),
    ...Object.keys(types),
  ]);
  return {
    window: { from: '2026-09-09T12:00:00.000Z', to: '2026-10-07T12:00:00.000Z' },
    globs: [...ids].map((id) => ({ id, type: types[id] ?? 'sub', status: 'signed_off', createdAt: AT })),
    events: [],
    artifacts: [],
    findings: [],
    manifestChanges: null,
    documents: [],
    learnings: [],
    ...patch,
  };
};

const measured = (a: BoardActivity, key: string): Measurement | undefined => measureSignals(a).find((m) => m.key === key);
const globs = (n: number, prefix = 's1t') => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1)}`);

describe('mined signals: recurring finding classes', () => {
  it('names the reviews that found the class in the statement (s15f8)', () => {
    const reviews = globs(3).map((g) => artifact(g, 'local_review'));
    const statement = (findings: ReviewFinding[]) => {
      const m = measured(activity({ artifacts: reviews, findings }), 'finding:edge-case');
      return m === undefined ? undefined : SIGNALS.find((s) => s.kind === 'finding')?.statement(m);
    };
    const local = globs(3).map((g) => finding(g, 'edge-case'));
    const rabbit = globs(3).map((g) => finding(g, 'edge-case', { source: 'coderabbit' }));
    expect(statement(local)).toMatch(/^Local reviews keep finding /);
    expect(statement(rabbit)).toMatch(/^CodeRabbit keeps finding /);
    expect(statement([...local.slice(0, 2), ...rabbit.slice(2)])).toMatch(/^Local reviews and CodeRabbit keep finding /);
  });

  it('counts globs with an IN-SCOPE finding of a class against reviewed globs, and crosses at 3 globs and 25%', () => {
    const reviewed = globs(12);
    const reviews = reviewed.map((g) => artifact(g, 'local_review'));
    const missingTests = ['s1t1', 's1t2', 's1t3'].flatMap((g) => [finding(g, 'missing-test'), finding(g, 'missing-test')]);
    const a = activity({ artifacts: reviews, findings: missingTests });
    expect(measured(a, 'finding:missing-test')).toMatchObject({
      kind: 'finding',
      label: 'new or changed behaviour without a test',
      figures: { affected: 3, eligible: 12, rate: 0.25, count: 6 },
      globIds: ['s1t1', 's1t2', 's1t3'],
      crosses: true,
    });
    // One more reviewed glob takes it under 25%.
    const diluted = activity({ artifacts: [...reviews, artifact('s1t13', 'local_review')], findings: missingTests });
    expect(measured(diluted, 'finding:missing-test')).toMatchObject({ figures: { affected: 3, eligible: 13 }, crosses: false });
    // Two globs at 100% is still under the 3-glob minimum.
    const two = activity({ artifacts: reviews.slice(0, 2), findings: missingTests.slice(0, 4) });
    expect(measured(two, 'finding:missing-test')).toMatchObject({ figures: { affected: 2, eligible: 2 }, crosses: false });
  });

  it("doesn't count suggestions, unclassified findings or `other`", () => {
    const a = activity({
      artifacts: globs(3).map((g) => artifact(g, 'local_review')),
      findings: [finding('s1t1', 'edge-case', { severity: 'suggestion' }), finding('s1t2', null), finding('s1t3', 'other')],
    });
    expect(measureSignals(a).filter((m) => m.kind === 'finding')).toEqual([]);
  });

  it('per glob: every reviewed glob is eligible, the ones with the class affected', () => {
    const a = activity({ artifacts: globs(3).map((g) => artifact(g, 'local_review')), findings: [finding('s1t1', 'security')] });
    expect(perGlob(a, 's1t1', 'finding:security')).toEqual({ eligible: true, affected: true });
    expect(perGlob(a, 's1t2', 'finding:security')).toEqual({ eligible: true, affected: false });
    expect(perGlob(a, 's1t9', 'finding:security')).toEqual({ eligible: false, affected: false });
    expect(perGlob(a, 's1t1', 'nonsense:key')).toEqual({ eligible: false, affected: false });
  });
});

describe('mined signals: CodeRabbit blind spots', () => {
  it('counts CodeRabbit findings of a class the local review of the same commit missed, at 3 findings on 2 globs', () => {
    const coderabbit = (g: string, cls: FindingClass, sha: string) => finding(g, cls, { source: 'coderabbit', commitSha: sha });
    const a = activity({
      artifacts: ['s1t1', 's1t2', 's1t3'].map((g) => artifact(g, 'local_review')),
      findings: [
        // s1t1: the local review of a later commit found it; this commit's review didn't.
        finding('s1t1', 'concurrency', { commitSha: 'bbbbbbb' }),
        finding('s1t1', 'logic-error', { commitSha: 'aaaaaaa' }),
        coderabbit('s1t1', 'concurrency', 'aaaaaaa1234'),
        coderabbit('s1t1', 'concurrency', 'aaaaaaa1234'),
        // s1t2: no local finding on this commit, so all its local findings are compared: none is concurrency.
        finding('s1t2', 'missing-test'),
        coderabbit('s1t2', 'concurrency', 'ccccccc'),
        // s1t3: the local review caught it.
        finding('s1t3', 'concurrency'),
        coderabbit('s1t3', 'concurrency', 'ddddddd'),
        // Nitpicks don't count; a glob without a local review isn't eligible.
        finding('s1t2', 'concurrency', { source: 'coderabbit', severity: 'suggestion' }),
        coderabbit('s1t9', 'concurrency', 'eeeeeee'),
      ],
    });
    expect(measured(a, 'blind_spot:concurrency')).toMatchObject({
      figures: { affected: 2, eligible: 3, count: 3 },
      globIds: ['s1t1', 's1t2'],
      crosses: true,
    });
    expect(perGlob(a, 's1t3', 'blind_spot:concurrency')).toEqual({ eligible: true, affected: false });
    expect(perGlob(a, 's1t9', 'blind_spot:concurrency')).toEqual({ eligible: false, affected: false });
  });

  it('stays under the threshold on one glob', () => {
    const a = activity({
      artifacts: [artifact('s1t1', 'local_review')],
      findings: [1, 2, 3].map(() => finding('s1t1', 'security', { source: 'coderabbit' })),
    });
    expect(measured(a, 'blind_spot:security')).toMatchObject({ figures: { affected: 1, count: 3 }, crosses: false });
  });
});

describe('mined signals: plans', () => {
  it('counts heavily amended implementation plans (3 versions, or 40% of lines changed), not supers', () => {
    const lines = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${String(i)}`).join('\n');
    const plan = (g: string, version: number, content: string) => artifact(g, 'implementation_plan', { version, content });
    const a = activity(
      {
        artifacts: [
          plan('s1t1', 1, 'a'),
          plan('s1t1', 2, 'b'),
          plan('s1t1', 3, 'c'),
          plan('s1t2', 1, lines(10)),
          plan('s1t2', 2, `${lines(6)}\n${lines(4, 'new')}`),
          plan('s1t3', 1, lines(10)),
          plan('s1t3', 2, `${lines(7)}\n${lines(3, 'new')}`),
          plan('s1t4', 1, lines(10)),
          plan('s1f1', 1, 'x'),
          plan('s1f1', 2, 'y'),
          plan('s1f1', 3, 'z'),
        ],
      },
      { s1f1: 'super' },
    );
    expect(measured(a, 'plan_amended')).toMatchObject({ figures: { affected: 2, eligible: 4 }, globIds: ['s1t1', 's1t2'], crosses: false });
    expect(perGlob(a, 's1f1', 'plan_amended')).toEqual({ eligible: false, affected: false });
    expect(lineChange(lines(10), `${lines(6)}\n${lines(4, 'new')}`)).toBeCloseTo(0.4);
    expect(lineChange('', '')).toBe(0);
  });

  it('counts plans edited between a failed or superseded run and its rerun, at 2 globs', () => {
    const rerun = (g: string, edit: DomainEvent | null, end: DomainEvent) => [
      end,
      ...(edit === null ? [] : [edit]),
      event(g, 'RunTriggered', { runId: 'r2', triggeredBy: 'dev@example.com' }),
      event(g, 'RunTriggered', { runId: 'r2', fired: true }),
    ];
    const a = activity({
      events: [
        ...rerun('s1t1', event('s1t1', 'FieldsChanged', { summary: { from: 'a', to: 'b' } }), event('s1t1', 'RunFailed', { runId: 'r1', reason: 'x' })),
        ...rerun('s1t2', event('s1t2', 'ArtifactAdded', { kind: 'plan' }), event('s1t2', 'RunEnded', { runId: 'r1', outcome: 'superseded' })),
        ...rerun('s1t3', null, event('s1t3', 'RunFailed', { runId: 'r1', reason: 'x' })),
        // An edit after a completed run isn't a rerun fix.
        event('s1t4', 'RunEnded', { runId: 'r1', outcome: 'completed' }),
        event('s1t4', 'FieldsChanged', { summary: { from: 'a', to: 'b' } }),
        event('s1t4', 'RunTriggered', { runId: 'r2' }),
      ],
    });
    expect(measured(a, 'plan_edited_rerun')).toMatchObject({ figures: { affected: 2, eligible: 3 }, globIds: ['s1t1', 's1t2'], crosses: true });
    expect(perGlob(a, 's1t3', 'plan_edited_rerun')).toEqual({ eligible: true, affected: false });
  });
});

describe('mined signals: review rounds and tester loops', () => {
  it('counts review cycles at the cap: recorded stats when present, else 3 or more parsed rounds', () => {
    const stats = (reviewRounds: number, maxReviewRounds: number, testFailRounds = 0): ReviewStats => ({
      riskTier: 'normal',
      reviewRounds,
      maxReviewRounds,
      testFailRounds,
    });
    const a = activity({
      artifacts: [
        artifact('s1t1', 'local_review', { reviewStats: stats(2, 2, 1) }),
        artifact('s1t2', 'local_review', { reviewStats: stats(3, 3, 2) }),
        artifact('s1t3', 'local_review', { content: '## Review (round 1)\n## Review (round 3)', reviewStats: stats(1, 3) }),
        artifact('s1t4', 'local_review', { content: '## Review (round 1)\n\n## Review (round 3)' }),
        artifact('s1t5', 'local_review', { reviewStats: stats(1, 1, 1) }),
        artifact('s1t6', 'local_review', { content: 'Round-1 items: fixed' }),
      ],
    });
    expect(measured(a, 'review_cap')).toMatchObject({
      figures: { affected: 3, eligible: 6, rate: 0.5 },
      globIds: ['s1t1', 's1t2', 's1t4'],
      crosses: true,
    });
    expect(measured(a, 'tester_loops')).toMatchObject({ figures: { affected: 3, eligible: 4, count: 4 }, crosses: true });
    expect(perGlob(a, 's1t4', 'tester_loops')).toEqual({ eligible: false, affected: false });
    expect(reviewRounds('## Review — s1 (round 2)\n## Round 10')).toBe(10);
    expect(reviewRounds('## Round-1 items')).toBe(0);
  });

  it('review_cap reads rounds only from headings, and leaves supers out (s15f8)', () => {
    // Prose naming a later round says nothing about how many rounds ran.
    const prose = '## Review (round 1)\n\nDeferred to round 3 (round 1 SUGGESTION 9).';
    expect(reviewRounds(prose)).toBe(1);
    const capped = (g: string) => artifact(g, 'local_review', { content: '## Review (round 1)\n### Round 2\n## Review (round 3)' });
    const a = activity(
      { artifacts: [capped('s1t1'), capped('s1t2'), capped('s1f3'), artifact('s1t4', 'local_review', { content: prose })] },
      { s1f3: 'super' },
    );
    // The super's review has rounds per strand: it is neither eligible nor affected.
    expect(measured(a, 'review_cap')).toMatchObject({ figures: { affected: 2, eligible: 3 }, globIds: ['s1t1', 's1t2'], crosses: false });
    expect(perGlob(a, 's1f3', 'review_cap')).toEqual({ eligible: false, affected: false });
  });
});

describe('mined signals: failures and superseded runs', () => {
  it('normalises failure reasons and crosses at 3 failures with one key', () => {
    expect(normaliseFailure('Run timed out: No progress for 2 hours')).toBe('run timed out no progress for hours');
    expect(normaliseFailure('Merge conflict with main in s15t3 at abc1234 (https://x.y/z) 3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(
      'merge conflict with main in at',
    );
    const a = activity({
      events: [
        event('s1t1', 'RunFailed', { runId: 'r1', reason: 'Run timed out: No progress for 2 hours' }),
        event('s1t2', 'RunFailed', { runId: 'r1', reason: 'Run timed out: No progress for 3 hours' }),
        event('s1t2', 'RunFailed', { runId: 'r0', reason: 'Run timed out: No progress for 9 hours', ignored: true }),
        event('s1t3', 'StatusChanged', { from: 'in_progress', to: 'failed', reason: 'Run timed out: no progress for 4 hours' }),
        event('s1t4', 'StatusChanged', { from: 'implementing', to: 'failed' }),
        event('s1t5', 'RunFailed', { runId: 'r1', reason: 'Tests fail' }),
      ],
    });
    expect(measured(a, 'failure:run timed out no progress for hours')).toMatchObject({
      figures: { affected: 3, eligible: 4, count: 3 },
      globIds: ['s1t1', 's1t2', 's1t3'],
      crosses: true,
    });
    expect(measured(a, 'failure:tests fail')).toMatchObject({ figures: { count: 1 }, crosses: false });
  });

  it('counts runs ended by a take-over or start again against ended runs, at 3 runs and 20%', () => {
    const runs = [
      event('s1t1', 'RunEnded', { runId: 'r1', outcome: 'superseded', cause: 'take_over' }),
      event('s1t2', 'RunEnded', { runId: 'r1', outcome: 'superseded', cause: 'start_again' }),
      event('s1t2', 'RunEnded', { runId: 'r2', outcome: 'superseded', cause: 'start_again' }, '2026-10-02T12:00:00.000Z'),
      event('s1t3', 'RunEnded', { runId: 'r1', outcome: 'superseded', cause: 'pr_closed' }),
      event('s1t4', 'RunFailed', { runId: 'r1', reason: 'x' }),
      ...globs(10, 's1b').map((g) => event(g, 'RunEnded', { runId: 'r1', outcome: 'completed' })),
    ];
    expect(measured(activity({ events: runs }), 'run_superseded')).toMatchObject({
      figures: { affected: 3, eligible: 15, rate: 0.2, count: 3 },
      globIds: ['s1t1', 's1t2'],
      crosses: true,
    });
    const more = [...runs, event('s1b11', 'RunEnded', { runId: 'r1', outcome: 'completed' })];
    expect(measured(activity({ events: more }), 'run_superseded')).toMatchObject({ figures: { eligible: 16 }, crosses: false });
    expect(perGlob(activity({ events: runs }), 's1t3', 'run_superseded')).toEqual({ eligible: true, affected: false });
  });

  it("gives a superseded run's example how long it ran and the last reason the glob recorded meanwhile (s15f8)", () => {
    const at = (hours: number) => new Date(Date.parse(AT) + hours * 60 * 60 * 1000).toISOString();
    const a = activity({
      events: [
        event('s1t1', 'RunTriggered', { runId: 'r1', triggeredBy: 'dev@example.com' }, at(0)),
        event('s1t1', 'MergeFailed', { reason: 'Merge conflict in a.ts' }, at(2)),
        event('s1t1', 'RunEnded', { runId: 'r1', outcome: 'superseded', cause: 'take_over' }, at(3)),
        event('s1t2', 'RunTriggered', { runId: 'r1' }, at(0)),
        event('s1t2', 'RunEnded', { runId: 'r1', outcome: 'superseded', cause: 'start_again' }, at(72)),
        // Before causes or triggers were in the window: just the cause and the day.
        event('s1t3', 'RunEnded', { runId: 'r9', outcome: 'superseded', cause: 'start_again' }, at(1)),
      ],
    });
    expect(measured(a, 'run_superseded')?.examples).toEqual([
      's1t1: take over on 2026-10-01 after 3h (last reason: Merge conflict in a.ts)',
      's1t2: start again on 2026-10-04 after 3 days',
      's1t3: start again on 2026-10-01',
    ]);
  });

  it('infers the cause of a superseded run recorded before causes were, from its transition\'s events', () => {
    const ended = (g: string) => event(g, 'RunEnded', { runId: 'r1', outcome: 'superseded' });
    const startAgain = [ended('s1t1'), event('s1t1', 'StatusChanged', { from: 'pr_open', to: 'implementing' }), event('s1t1', 'RunTriggered', { runId: 'r2' })];
    const takeOver = [ended('s1t2'), event('s1t2', 'PickedUp', { takeOver: true })];
    const closed = [event('s1t3', 'PRClosed'), ended('s1t3')];
    const all = [...startAgain, ...takeOver, ...closed, event('s1t3', 'PRClosed', {}, '2026-10-03T00:00:00.000Z')];
    expect(supersededCause(startAgain[0] ?? ended('x'), all)).toBe('start_again');
    expect(supersededCause(takeOver[0] ?? ended('x'), all)).toBe('take_over');
    expect(supersededCause(closed[1] ?? ended('x'), all)).toBe('pr_closed');
    expect(supersededCause(event('s1t4', 'RunEnded', { outcome: 'superseded', cause: 'deleted' }), all)).toBe('deleted');
  });
});

describe('mined signals: sub conversions', () => {
  it('counts subs the gate turned into sames against gated subs, at 3 and 30%', () => {
    const gated = (g: string, passed: boolean) => [
      event(g, 'SubReviewCompleted', { sha: 'a', passed, reason: passed ? null : 'Changes 2898 lines (limit 2000)' }),
      ...(passed ? [] : [event(g, 'FieldsChanged', { type: { from: 'sub', to: 'same' } })]),
    ];
    const a = activity({ events: [...gated('s1t1', false), ...gated('s1t2', false), ...gated('s1t3', false), ...globs(7, 's1b').flatMap((g) => gated(g, true))] });
    expect(measured(a, 'sub_converted')).toMatchObject({ figures: { affected: 3, eligible: 10, rate: 0.3 }, crosses: true });
    expect(measured(a, 'sub_converted')?.examples[0]).toBe('s1t1: Changes 2898 lines (limit 2000)');
  });
});

describe('mined signals: CI failing after local checks', () => {
  it('counts distinct failed commits that had a local review (short SHAs match) or a routine push, per glob', () => {
    const build = (g: string, sha: string, passed: boolean, extra: DomainEvent['data'] = {}) => event(g, 'BuildCompleted', { sha, passed, ...extra });
    const a = activity({
      artifacts: [artifact('s1f5', 'local_review', { commitSha: 'be0976c' })],
      events: [
        // Reviewed locally at its short SHA; BuildCompleted repeats on each refresh.
        build('s1f5', 'be0976c92393d017198da46066a22f8ba5772c49', false),
        build('s1f5', 'be0976c92393d017198da46066a22f8ba5772c49', false),
        // Pushed by a routine run.
        event('s1t3', 'CommitPushed', { sha: '5713c53', runId: 'run-1' }),
        build('s1t3', '5713c53', false),
        // Neither: a person's push with no local review.
        event('s1t4', 'CommitPushed', { sha: 'd1aa202', runId: null }),
        build('s1t4', 'd1aa202', false),
        // Inherited from a red base branch (s15t7): left out.
        event('s1b4', 'CommitPushed', { sha: '8911624', runId: 'run-2' }),
        build('s1b4', '8911624', false, { inheritedFrom: 'main' }),
        ...globs(16, 's1x').map((g) => build(g, 'aaaaaaa', true)),
      ],
    });
    expect(measured(a, 'ci_after_local')).toMatchObject({
      figures: { affected: 2, eligible: 20, rate: 0.1, count: 2 },
      globIds: ['s1f5', 's1t3'],
      crosses: true,
    });
    expect(perGlob(a, 's1b4', 'ci_after_local')).toEqual({ eligible: true, affected: false });
    expect(sameCommit('be0976c', 'be0976c92393d017198da46066a22f8ba5772c49')).toBe(true);
    expect(sameCommit('be097', 'be0976c92393')).toBe(false);
    expect(sameCommit(null, 'be0976c')).toBe(false);
  });
});

describe('mined signals: new dependencies', () => {
  it('raises dependencies a merged glob added that no board document mentions; unmeasured without manifests', () => {
    const a = activity({
      manifestChanges: [
        { globId: 's1t1', sha: 'm1', path: 'package.json', dependencies: ['zustand', 'zod'] },
        { globId: 's1t2', sha: 'm2', path: 'package.json', dependencies: [] },
      ],
      documents: [{ name: 'typescript_conventions', content: 'Validate with Zod at boundaries.' }],
    });
    expect(measureSignals(a).filter((m) => m.kind === 'dependency')).toEqual([
      expect.objectContaining({ key: 'dependency:zustand', figures: { affected: 1, eligible: 2, rate: 0.5, count: 1 }, crosses: true }),
    ]);
    expect(measureSignals(activity()).filter((m) => m.kind === 'dependency')).toEqual([]);
  });

  it('parses added dependencies from each manifest kind', () => {
    expect(isManifestPath('apps/web/package.json')).toBe(true);
    expect(isManifestPath('requirements-dev.txt')).toBe(true);
    expect(isManifestPath('src/package.json.ts')).toBe(false);
    expect(addedDependencies('package.json', '{"dependencies":{"a":"1"}}', '{"dependencies":{"a":"1","b":"2"},"devDependencies":{"c":"3","d":"workspace:*"}}')).toEqual(['b', 'c']);
    expect(addedDependencies('package.json', null, 'not json')).toEqual([]);
    expect(addedDependencies('requirements.txt', 'Django==4\n', 'django==5\nrequests[socks]>=2 ; python_version > "3"\n-r base.txt\n# x\n')).toEqual(['requests']);
    expect(
      addedDependencies(
        'pyproject.toml',
        '[project]\ndependencies = ["httpx>=0.27"]\n',
        '[project]\nname = "x"\ndependencies = [\n  "httpx>=0.27",\n  "pydantic>=2",\n]\n[project.optional-dependencies]\ndev = ["pytest"]\n[tool.poetry.dependencies]\npython = "^3.12"\nrich = "^13"\n',
      ),
    ).toEqual(['pydantic', 'pytest', 'rich']);
    expect(
      addedDependencies(
        'Cargo.toml',
        '[dependencies]\nserde = "1"\n',
        '[package]\nname = "x"\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n[dev-dependencies]\ninsta = "1"\n[dependencies.reqwest]\nversion = "0.12"\n',
      ),
    ).toEqual(['insta', 'reqwest', 'tokio']);
    expect(
      addedDependencies(
        'go.mod',
        'module x\nrequire github.com/a/b v1.0.0\n',
        'module x\nrequire github.com/a/b v1.0.0\nrequire (\n\tgithub.com/c/d v0.2.0\n\tgolang.org/x/e v0.1.0 // indirect\n)\n',
      ),
    ).toEqual(['github.com/c/d']);
    expect(addedDependencies('README.md', null, 'x')).toEqual([]);
  });
});

describe('mined signals: a glob\'s agent-set version', () => {
  it('takes the commit trailer, else the highest recorded on artifacts, failures or learnings, else null', () => {
    const base = activity({
      artifacts: [artifact('s1t1', 'local_review', { provenance: { by: 'routine', actor: 'a', runId: 'r', agentSetVersion: 4 } })],
      events: [event('s1t1', 'RunFailed', { reason: 'x', agentSetVersion: 6 }), event('s1t2', 'CommitPushed', { sha: 'a', agentSetVersion: 9 })],
      learnings: [{ globIds: ['s1t1'], agentSetVersion: 5 }],
    });
    expect(globAgentSetVersion(base, 's1t1')).toBe(6);
    expect(globAgentSetVersion(base, 's1t2')).toBe(9);
    expect(globAgentSetVersion(base, 's1t3')).toBeNull();
  });

  it('lists every signal with an agent, a type and a threshold', () => {
    expect(SIGNALS.map((s) => [s.kind, s.agent])).toEqual([
      ['finding', 'implementer'],
      ['blind_spot', 'change_reviewer'],
      ['plan_amended', 'investigator'],
      ['plan_edited_rerun', 'investigator'],
      ['review_cap', 'implementer'],
      ['tester_loops', 'implementer'],
      ['failure', 'orchestrator'],
      ['run_superseded', 'orchestrator'],
      ['sub_converted', 'orchestrator'],
      ['ci_after_local', 'orchestrator'],
      ['dependency', null],
    ]);
    expect(SIGNALS.every((s) => s.threshold !== '')).toBe(true);
  });
});

describe('mined signals: threshold edges (s15f8)', () => {
  const stats = (reviewRounds: number, maxReviewRounds: number, testFailRounds = 0): ReviewStats => ({
    riskTier: 'normal',
    reviewRounds,
    maxReviewRounds,
    testFailRounds,
  });
  const lines = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${String(i)}`).join('\n');

  it('plan_amended crosses at 3 globs and 25% of globs with a plan, not below', () => {
    const amended = globs(3).flatMap((g) => [1, 2, 3].map((v) => artifact(g, 'implementation_plan', { version: v, content: `v${String(v)}` })));
    const steady = (n: number) => globs(n, 's1b').map((g) => artifact(g, 'implementation_plan', { content: lines(5) }));
    expect(measured(activity({ artifacts: [...amended, ...steady(9)] }), 'plan_amended')).toMatchObject({ figures: { affected: 3, eligible: 12 }, crosses: true });
    expect(measured(activity({ artifacts: [...amended, ...steady(10)] }), 'plan_amended')).toMatchObject({ figures: { affected: 3, eligible: 13 }, crosses: false });
    // 39% of lines changed on 2 versions isn't heavy amendment.
    const light = activity({ artifacts: [artifact('s1t1', 'implementation_plan', { content: lines(100) }), artifact('s1t1', 'implementation_plan', { version: 2, content: `${lines(61)}\n${lines(39, 'new')}` })] });
    expect(measured(light, 'plan_amended')).toBeUndefined();
  });

  it('plan_edited_rerun needs 2 globs', () => {
    const a = activity({
      events: [
        event('s1t1', 'RunFailed', { runId: 'r1', reason: 'x' }),
        event('s1t1', 'FieldsChanged', { summary: { from: 'a', to: 'b' } }),
        event('s1t1', 'RunTriggered', { runId: 'r2' }),
      ],
    });
    expect(measured(a, 'plan_edited_rerun')).toMatchObject({ figures: { affected: 1, eligible: 1 }, crosses: false });
  });

  it('review_cap crosses at 3 globs and 30% of reviewed globs, not below', () => {
    const capped = globs(3).map((g) => artifact(g, 'local_review', { reviewStats: stats(2, 2) }));
    const fine = (n: number) => globs(n, 's1b').map((g) => artifact(g, 'local_review', { reviewStats: stats(1, 2) }));
    expect(measured(activity({ artifacts: [...capped, ...fine(7)] }), 'review_cap')).toMatchObject({ figures: { affected: 3, eligible: 10 }, crosses: true });
    expect(measured(activity({ artifacts: [...capped, ...fine(8)] }), 'review_cap')).toMatchObject({ figures: { affected: 3, eligible: 11 }, crosses: false });
    expect(measured(activity({ artifacts: capped.slice(0, 2) }), 'review_cap')).toMatchObject({ figures: { affected: 2, eligible: 2 }, crosses: false });
  });

  it("review_cap reads only a glob's latest local review", () => {
    const a = activity({ artifacts: [artifact('s1t1', 'local_review', { reviewStats: stats(3, 3) }), artifact('s1t1', 'local_review', { version: 2, reviewStats: stats(1, 3) })] });
    expect(measured(a, 'review_cap')).toBeUndefined();
    expect(perGlob(a, 's1t1', 'review_cap')).toEqual({ eligible: true, affected: false });
  });

  it('tester_loops crosses at 3 globs with a loop and 30% of globs with stats, not below', () => {
    const looped = globs(3).map((g) => artifact(g, 'local_review', { reviewStats: stats(1, 2, 1) }));
    const clean = (n: number) => globs(n, 's1b').map((g) => artifact(g, 'local_review', { reviewStats: stats(1, 2, 0) }));
    expect(measured(activity({ artifacts: [...looped, ...clean(7)] }), 'tester_loops')).toMatchObject({ figures: { affected: 3, eligible: 10 }, crosses: true });
    expect(measured(activity({ artifacts: [...looped, ...clean(8)] }), 'tester_loops')).toMatchObject({ crosses: false });
    expect(measured(activity({ artifacts: [...looped.slice(0, 2)] }), 'tester_loops')).toMatchObject({ crosses: false });
  });

  it('failure needs 3 failures with one key; 2 is below', () => {
    const a = activity({ events: ['s1t1', 's1t2'].map((g) => event(g, 'RunFailed', { runId: 'r1', reason: 'Push rejected' })) });
    expect(measured(a, 'failure:push rejected')).toMatchObject({ figures: { count: 2 }, crosses: false });
    // The same glob failing 3 times for one reason crosses (failures, not globs).
    const same = activity({ events: [1, 2, 3].map((i) => event('s1t1', 'RunFailed', { runId: `r${String(i)}`, reason: 'Push rejected' })) });
    expect(measured(same, 'failure:push rejected')).toMatchObject({ figures: { affected: 3, eligible: 3, count: 3 }, globIds: ['s1t1'], crosses: true });
  });

  it('run_superseded needs 3 runs even at a high rate', () => {
    const a = activity({ events: ['s1t1', 's1t2'].map((g) => event(g, 'RunEnded', { runId: 'r1', outcome: 'superseded', cause: 'take_over' })) });
    expect(measured(a, 'run_superseded')).toMatchObject({ figures: { affected: 2, eligible: 2, rate: 1 }, crosses: false });
  });

  it('sub_converted needs 3 subs and 30% of gated subs', () => {
    const gated = (g: string, passed: boolean) => event(g, 'SubReviewCompleted', { sha: 'a', passed, reason: passed ? null : 'Too big' });
    const failed = globs(3).map((g) => gated(g, false));
    const passed = (n: number) => globs(n, 's1b').map((g) => gated(g, true));
    expect(measured(activity({ events: [...failed, ...passed(8)] }), 'sub_converted')).toMatchObject({ figures: { affected: 3, eligible: 11 }, crosses: false });
    expect(measured(activity({ events: failed.slice(0, 2) }), 'sub_converted')).toMatchObject({ figures: { affected: 2, eligible: 2 }, crosses: false });
    // A sub that failed the gate once and passed later still counts as converted.
    const retried = activity({ events: [gated('s1t1', false), gated('s1t1', true)] });
    expect(perGlob(retried, 's1t1', 'sub_converted')).toEqual({ eligible: true, affected: true });
  });

  it('ci_after_local needs 2 globs and 10% of globs with builds', () => {
    const failedAfterPush = (g: string, sha: string) => [event(g, 'CommitPushed', { sha, runId: 'run' }), event(g, 'BuildCompleted', { sha, passed: false })];
    const green = (n: number) => globs(n, 's1x').map((g) => event(g, 'BuildCompleted', { sha: 'fffffff', passed: true }));
    expect(measured(activity({ events: failedAfterPush('s1t1', 'aaaaaaa') }), 'ci_after_local')).toMatchObject({ figures: { affected: 1, eligible: 1 }, crosses: false });
    const two = [...failedAfterPush('s1t1', 'aaaaaaa'), ...failedAfterPush('s1t2', 'bbbbbbb')];
    expect(measured(activity({ events: [...two, ...green(18)] }), 'ci_after_local')).toMatchObject({ figures: { affected: 2, eligible: 20 }, crosses: true });
    expect(measured(activity({ events: [...two, ...green(19)] }), 'ci_after_local')).toMatchObject({ figures: { affected: 2, eligible: 21 }, crosses: false });
  });

  it('blind_spot needs 3 findings: 2 findings on 2 globs is below', () => {
    const a = activity({
      artifacts: ['s1t1', 's1t2'].map((g) => artifact(g, 'local_review')),
      findings: ['s1t1', 's1t2'].map((g) => finding(g, 'security', { source: 'coderabbit' })),
    });
    expect(measured(a, 'blind_spot:security')).toMatchObject({ figures: { affected: 2, count: 2 }, crosses: false });
  });
});

describe('mined signals: perGlob for every signal (s15f8)', () => {
  it('marks the affected globs of each signal and leaves the rest unaffected', () => {
    const a = activity(
      {
        artifacts: [
          artifact('s1t1', 'local_review', {
            commitSha: 'aaaaaaa',
            reviewStats: { riskTier: 'normal', reviewRounds: 2, maxReviewRounds: 2, testFailRounds: 1 },
          }),
          artifact('s1t2', 'local_review', { reviewStats: { riskTier: 'normal', reviewRounds: 1, maxReviewRounds: 2, testFailRounds: 0 } }),
          ...[1, 2, 3].map((v) => artifact('s1t3', 'implementation_plan', { version: v, content: `v${String(v)}` })),
          artifact('s1t4', 'implementation_plan', { content: 'same' }),
        ],
        findings: [finding('s1t2', 'security', { source: 'coderabbit' })],
        events: [
          event('s1t1', 'BuildCompleted', { sha: 'aaaaaaa1111', passed: false }),
          event('s1t2', 'BuildCompleted', { sha: 'bbbbbbb', passed: false }),
          event('s1t5', 'RunFailed', { runId: 'r1', reason: 'Push rejected' }),
          event('s1t5', 'FieldsChanged', { summary: { from: 'a', to: 'b' } }),
          event('s1t5', 'RunTriggered', { runId: 'r2' }),
          event('s1t6', 'RunEnded', { runId: 'r1', outcome: 'superseded', cause: 'take_over' }),
          event('s1t6', 'RunTriggered', { runId: 'r2' }),
          event('s1t7', 'RunEnded', { runId: 'r1', outcome: 'completed' }),
          event('s1t8', 'SubReviewCompleted', { sha: 'a', passed: false, reason: 'Too big' }),
          event('s1t9', 'SubReviewCompleted', { sha: 'a', passed: true }),
        ],
        manifestChanges: [
          { globId: 's1t9', sha: 'm', path: 'package.json', dependencies: ['zustand'] },
          { globId: 's1t8', sha: 'n', path: 'package.json', dependencies: [] },
        ],
      },
      {},
    );
    const cases: [string, string, { eligible: boolean; affected: boolean }][] = [
      ['blind_spot:security', 's1t2', { eligible: true, affected: true }],
      ['plan_amended', 's1t3', { eligible: true, affected: true }],
      ['plan_amended', 's1t4', { eligible: true, affected: false }],
      ['plan_edited_rerun', 's1t5', { eligible: true, affected: true }],
      ['plan_edited_rerun', 's1t6', { eligible: true, affected: false }],
      ['review_cap', 's1t1', { eligible: true, affected: true }],
      ['review_cap', 's1t2', { eligible: true, affected: false }],
      ['tester_loops', 's1t1', { eligible: true, affected: true }],
      ['tester_loops', 's1t2', { eligible: true, affected: false }],
      ['failure:push rejected', 's1t5', { eligible: true, affected: true }],
      ['failure:push rejected', 's1t1', { eligible: false, affected: false }],
      ['run_superseded', 's1t6', { eligible: true, affected: true }],
      ['run_superseded', 's1t7', { eligible: true, affected: false }],
      ['sub_converted', 's1t8', { eligible: true, affected: true }],
      ['sub_converted', 's1t9', { eligible: true, affected: false }],
      ['ci_after_local', 's1t1', { eligible: true, affected: true }],
      ['ci_after_local', 's1t2', { eligible: true, affected: false }],
      ['dependency:zustand', 's1t9', { eligible: true, affected: true }],
      ['dependency:zustand', 's1t8', { eligible: true, affected: false }],
    ];
    for (const [key, globId, expected] of cases) expect([key, globId, perGlob(a, globId, key)]).toEqual([key, globId, expected]);
  });
});

describe('mined signals: ci_after_local details (s15f8)', () => {
  const build = (g: string, sha: string, passed: boolean, extra: DomainEvent['data'] = {}) => event(g, 'BuildCompleted', { sha, passed, ...extra });

  it('counts each distinct failed commit of a glob, and the glob once', () => {
    const a = activity({
      events: [
        event('s1t1', 'CommitPushed', { sha: 'aaaaaaa', runId: 'run' }),
        event('s1t1', 'CommitPushed', { sha: 'bbbbbbb', runId: 'run' }),
        build('s1t1', 'aaaaaaa', false),
        build('s1t1', 'aaaaaaa', false),
        build('s1t1', 'bbbbbbb', false),
        event('s1t2', 'CommitPushed', { sha: 'ccccccc', runId: 'run' }),
        build('s1t2', 'ccccccc', false),
      ],
    });
    expect(measured(a, 'ci_after_local')).toMatchObject({ figures: { affected: 2, eligible: 2, count: 3 } });
    const unchecked = '; not compared with the base branch, so possibly inherited from a red base';
    expect(measured(a, 'ci_after_local')?.examples).toEqual([`s1t1: CI failed on aaaaaaa, bbbbbbb${unchecked}`, `s1t2: CI failed on ccccccc${unchecked}`]);
  });

  it("names the failing check from the build event's failure summary, and notes only commits not compared with the base", () => {
    const a = activity({
      events: [
        event('s1t1', 'CommitPushed', { sha: 'aaaaaaa', runId: 'run' }),
        event('s1t1', 'CommitPushed', { sha: 'bbbbbbb', runId: 'run' }),
        build('s1t1', 'aaaaaaa', false, { failure: 'Type check: error TS2322' }),
        build('s1t1', 'bbbbbbb', false, { failure: 'Unit tests: 1 failed' }),
        event('s1t2', 'CommitPushed', { sha: 'ccccccc', runId: 'run' }),
        build('s1t2', 'ccccccc', false, { failure: 'Lint' }),
        build('s1t2', 'ddddddd', false, { failure: 'Lint', inheritedFrom: 'main' }),
      ],
    });
    expect(measured(a, 'ci_after_local')?.examples).toEqual([
      's1t1: CI failed on aaaaaaa (Type check: error TS2322), bbbbbbb (Unit tests: 1 failed)',
      's1t2: CI failed on ccccccc (Lint)',
    ]);
  });

  it("doesn't count a passed build, another glob's review of the same commit, or a review at too short a SHA", () => {
    const a = activity({
      artifacts: [artifact('s1t2', 'local_review', { commitSha: 'aaaaaaa' }), artifact('s1t3', 'local_review', { commitSha: 'bbbbbb' })],
      events: [build('s1t1', 'aaaaaaa', true), build('s1t1', 'aaaaaaa1', false), build('s1t3', 'bbbbbb12', false)],
    });
    expect(measured(a, 'ci_after_local')).toBeUndefined();
  });

  it('only leaves out a failure whose inheritedFrom names a base branch', () => {
    const a = activity({
      artifacts: [artifact('s1t1', 'local_review', { commitSha: 'aaaaaaa' })],
      events: [build('s1t1', 'aaaaaaa', false, { inheritedFrom: null })],
    });
    expect(measured(a, 'ci_after_local')).toMatchObject({ figures: { affected: 1 } });
  });

  it('matches SHAs case-insensitively at 7 characters or more', () => {
    expect(sameCommit('BE0976C', 'be0976c92393')).toBe(true);
    expect(sameCommit('be0976c', 'be0976c')).toBe(true);
    expect(sameCommit('be0976d', 'be0976c92393')).toBe(false);
    expect(sameCommit('be0976', 'be0976')).toBe(false);
  });
});

describe('manifests: more formats and exclusions (s15f8)', () => {
  it('reads every package.json dependency section and leaves out link: and file: specs', () => {
    expect(
      addedDependencies(
        'package.json',
        '{}',
        JSON.stringify({ peerDependencies: { react: '*' }, optionalDependencies: { fsevents: '2' }, dependencies: { a: 'link:../a', b: 'file:../b' }, scripts: { zod: 'x' } }),
      ),
    ).toEqual(['fsevents', 'react']);
  });

  it('reads requirements names, normalising case and underscores, and skips options', () => {
    expect(addedDependencies('requirements.txt', '', 'Typing_Extensions~=4.0\n-e ./local\n--index-url https://x\nrich  # pretty\n')).toEqual(['rich', 'typing-extensions']);
  });

  it('reads Cargo target and build dependency tables', () => {
    expect(addedDependencies('Cargo.toml', '', "[target.'cfg(unix)'.dependencies]\nlibc = \"0.2\"\n[build-dependencies]\ncc = \"1\"\n[package]\nversion = \"1\"\n")).toEqual(['cc', 'libc']);
  });

  it('reads a single-line go.mod require and leaves out indirect ones', () => {
    expect(addedDependencies('go.mod', null, 'module x\nrequire github.com/a/b v1.0.0\nrequire github.com/c/d v1.0.0 // indirect\n')).toEqual(['github.com/a/b']);
  });

  it('names nothing for a deleted manifest', () => {
    expect(addedDependencies('package.json', '{"dependencies":{"a":"1"}}', null)).toEqual([]);
  });
});
