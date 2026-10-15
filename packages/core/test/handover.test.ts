import { describe, expect, it } from 'vitest';
import {
  handoverBrief,
  handoverMarkdown,
  openFindings,
  resumePhase,
} from '../src/domain/handover.js';
import type { HandoverFacts } from '../src/domain/handover.js';
import type { ArtifactSummary } from '../src/domain/knowledge.js';
import type { ReviewFinding, ReviewSource } from '../src/domain/findings.js';
import { NOW, glob, run } from './fixtures.js';

const HEAD = 'a2a88c8aaaa';
const facts = (patch: Partial<HandoverFacts> = {}): HandoverFacts => ({
  now: NOW,
  findings: 0,
  resumePhase: 4,
  ...patch,
});
const minutesAgo = (n: number): string => new Date(Date.parse(NOW) - n * 60_000).toISOString();
const open = (patch = {}) =>
  glob({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: HEAD }, ...patch });
const failedChecks = (patch = {}) => ({
  sha: HEAD,
  state: 'failed' as const,
  at: NOW,
  failure: {
    name: 'ci',
    step: 'test',
    lines: ['Error: boom', 'at x.ts:1'],
    url: 'https://ci.example/run/1',
  },
  ...patch,
});

describe('handoverBrief', () => {
  it('is null when nothing is wrong, also with a healthy live run', () => {
    expect(handoverBrief(open(), facts())).toBeNull();
    expect(handoverBrief(open({ runs: [run({ state: 'watching' })] }), facts())).toBeNull();
  });

  it('explains a conflict with the files, and the extra ones in the detail', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    const brief = handoverBrief(
      open({ conflict: { base: 'main', files, since: 's1t9', at: NOW } }),
      facts(),
    );
    expect(brief?.why).toEqual([
      'Conflicts with main since s1t9 merged: a.ts, b.ts, c.ts, d.ts, e.ts and 2 more.',
    ]);
    expect(brief?.next).toBe(
      'Merge origin/main, resolve (additive conflicts keep both sides; ask about logic conflicts), run the checks, push.',
    );
    expect(brief?.detail).toEqual(['More conflicting files: f.ts, g.ts']);
  });

  it('names the conflict base in the step, and leaves the card tail and doubled dots out of why', () => {
    const conflict = {
      base: 'develop',
      files: [],
      since: null,
      at: NOW,
      requestedAt: minutesAgo(60),
    };
    const brief = handoverBrief(open({ implementer: 'dev@example.com', conflict }), facts());
    expect(brief?.why).toEqual(['Conflicts with develop.']);
    expect(brief?.why.join(' ')).not.toContain('Resolve locally');
    expect(brief?.why.join(' ')).not.toContain('..');
    expect(brief?.next).toMatch(/^Merge origin\/develop, resolve/);
  });

  it('is null for a signed-off glob whatever its last run or findings say', () => {
    const failed = run({ state: 'ended', outcome: 'failed' });
    expect(
      handoverBrief(open({ status: 'signed_off', runs: [failed] }), facts({ findings: 2 })),
    ).toBeNull();
  });

  it('treats a failed merge on a conflict as the conflict cause, with the reason', () => {
    const failure = {
      reason: 'Merge failed',
      at: NOW,
      kind: 'merge' as const,
      conflict: { base: 'main', files: ['a.ts'] },
    };
    const brief = handoverBrief(glob({ status: 'failed', failure }), facts());
    expect(brief?.why).toEqual(['Conflicts with main: a.ts.']);
    expect(brief?.detail).toContain('Reason: Merge failed');
  });

  it('reports a failure and its decision verbatim, with the phase to continue from', () => {
    const decision = 'Keep the old API or break it? (see "plan.md")';
    const failure = { reason: 'Needs a call', at: NOW, kind: 'needs_pairing' as const, decision };
    const brief = handoverBrief(glob({ status: 'failed', failure }), facts({ resumePhase: 3 }));
    expect(brief?.why).toEqual(['Failed: Needs a call']);
    expect(brief?.detail).toContain(`Decision needed: ${decision}`);
    expect(brief?.next).toBe(
      'Answer the decision (ask the developer), then continue from phase 3.',
    );
  });

  it('still reports the reason of a failure with no decision', () => {
    const brief = handoverBrief(
      glob({ status: 'failed', failure: { reason: 'Timed out', at: NOW } }),
      facts(),
    );
    expect(brief?.why).toEqual(['Failed: Timed out']);
    expect(brief?.detail).toEqual([]);
    expect(brief?.next).toBe('Fix the cause, then continue from phase 4.');
  });

  it('reports real failed checks with lines, url and head sha', () => {
    const brief = handoverBrief(open({ headChecks: failedChecks() }), facts());
    expect(brief?.why).toHaveLength(1);
    expect(brief?.why[0]).toMatch(/^Checks failed: /);
    expect(brief?.next).toBe('Reproduce with the failing CI command locally and fix.');
    expect(brief?.detail).toEqual([
      'Error: boom',
      'at x.ts:1',
      'Run: https://ci.example/run/1',
      `Head: ${HEAD}`,
    ]);
  });

  it('skips checks inherited from a red base branch', () => {
    const headChecks = failedChecks({ inheritedFrom: { base: 'main', since: null } });
    expect(handoverBrief(open({ headChecks }), facts())).toBeNull();
  });

  it('ignores failed checks of an older head', () => {
    expect(handoverBrief(open({ headChecks: failedChecks({ sha: 'old' }) }), facts())).toBeNull();
  });

  it('reports a failed run, a stalled run and a run queued too long, with the session', () => {
    const session = 'https://claude.ai/code/session_1';
    const failed = handoverBrief(
      open({
        runs: [
          run({
            state: 'ended',
            outcome: 'failed',
            failureReason: 'out of budget',
            sessionUrl: session,
          }),
        ],
      }),
      facts({ resumePhase: 5 }),
    );
    expect(failed?.why[0]).toBe('The last run ended without finishing: out of budget');
    expect(failed?.next).toBe('Resume from the last uploaded phase (`--from 5`).');
    expect(failed?.detail).toEqual([
      'Outcome: failed',
      `Last progress: ${NOW}`,
      `Session: ${session}`,
    ]);

    const stalled = handoverBrief(
      open({
        runs: [run({ state: 'watching', lastProgressAt: minutesAgo(40), sessionUrl: session })],
      }),
      facts(),
    );
    expect(stalled?.why).toEqual(['The run has made no progress for 40 minutes.']);
    expect(stalled?.detail).toEqual([`Last progress: ${minutesAgo(40)}`, `Session: ${session}`]);

    // A run that only watches a glob that is merging, armed or queued has nothing to report: no false stall.
    const watching = [run({ state: 'watching', lastProgressAt: minutesAgo(26) })];
    const checksPassed = { sha: HEAD, state: 'passed' as const };
    const waiting = [
      open({ status: 'merging', runs: watching, headChecks: checksPassed }),
      open({ mergeMode: 'when_green', runs: watching, headChecks: checksPassed }),
      open({
        status: 'merging',
        runs: watching,
        headChecks: checksPassed,
        mergeQueue: { since: NOW, sha: HEAD, position: 2, state: 'queued' },
      }),
    ];
    for (const g of waiting) expect(handoverBrief(g, facts())).toBeNull();
    // The same quiet run on a plain open PR still shows.
    expect(handoverBrief(open({ runs: watching }), facts())?.why).toEqual(['The run has made no progress for 26 minutes.']);
    expect(
      handoverBrief(
        open({ runs: [run({ state: 'active', lastProgressAt: minutesAgo(5) })] }),
        facts(),
      ),
    ).toBeNull();

    const queued = handoverBrief(
      open({
        runs: [
          run({ state: 'queued', queuedAt: minutesAgo(25), startedAt: null, lastProgressAt: null }),
        ],
      }),
      facts(),
    );
    expect(queued?.why).toEqual(['The run has been queued for 25 minutes without starting.']);
    expect(
      handoverBrief(
        open({
          runs: [
            run({
              state: 'queued',
              queuedAt: minutesAgo(3),
              startedAt: null,
              lastProgressAt: null,
            }),
          ],
        }),
        facts(),
      ),
    ).toBeNull();
  });

  it('does not count superseded or completed runs, or an investigate-only run', () => {
    expect(
      handoverBrief(open({ runs: [run({ state: 'ended', outcome: 'superseded' })] }), facts()),
    ).toBeNull();
    expect(
      handoverBrief(open({ runs: [run({ state: 'ended', outcome: 'completed' })] }), facts()),
    ).toBeNull();
    const investigate = run({ state: 'ended', outcome: 'failed', purpose: 'investigate' });
    expect(handoverBrief(open({ runs: [investigate] }), facts())).toBeNull();
    // The work run before it decides.
    const work = run({ id: 'run-1', state: 'ended', outcome: 'completed' });
    expect(handoverBrief(open({ runs: [work, investigate] }), facts())).toBeNull();
  });

  it('does not repeat the glob failure as a failed run', () => {
    const failed = run({ state: 'ended', outcome: 'failed', failureReason: 'boom' });
    const brief = handoverBrief(
      glob({ status: 'failed', failure: { reason: 'boom', at: NOW }, runs: [failed] }),
      facts(),
    );
    expect(brief?.why).toEqual(['Failed: boom']);
  });

  it('reports open in-scope findings with the link', () => {
    const brief = handoverBrief(open(), facts({ findings: 2 }));
    expect(brief?.why).toEqual(['2 in-scope review findings still open.']);
    expect(brief?.next).toBe('Fix all review comments.');
    expect(brief?.detail).toEqual(['Findings: ?section=findings']);
    expect(handoverBrief(open(), facts({ findings: 1 }))?.why).toEqual([
      '1 in-scope review finding still open.',
    ]);
  });

  it('lists every cause in order and takes the first cause next step; a conflict beats checks', () => {
    const brief = handoverBrief(
      open({
        conflict: { base: 'main', files: ['a.ts'], since: null, at: NOW },
        headChecks: failedChecks(),
        runs: [run({ state: 'ended', outcome: 'failed', failureReason: 'x' })],
      }),
      facts({ findings: 3 }),
    );
    expect(brief?.why).toHaveLength(4);
    expect(brief?.why[0]).toMatch(/^Conflicts with main/);
    expect(brief?.why[1]).toMatch(/^Checks failed/);
    expect(brief?.why[2]).toMatch(/^The last run ended/);
    expect(brief?.why[3]).toMatch(/^3 in-scope review findings/);
    expect(brief?.next).toMatch(/^Merge origin\/main/);
  });

  it('puts a failure before checks', () => {
    const brief = handoverBrief(
      glob({
        status: 'failed',
        failure: { reason: 'r', at: NOW },
        pr: { number: 7, state: 'ready', headSha: HEAD },
        headChecks: failedChecks(),
      }),
      facts(),
    );
    expect(brief?.why.map((w) => w.split(':')[0])).toEqual(['Failed', 'Checks failed']);
    expect(brief?.next).toMatch(/^Fix the cause/);
  });

  it('renders the brief as markdown', () => {
    const text = handoverMarkdown({ why: ['A.', 'B.'], next: 'Do it.', detail: ['x'] });
    expect(text).toBe('## Why you are needed\n- A.\n- B.\n\n## Do first\nDo it.\n\n## Detail\n- x');
    expect(handoverMarkdown({ why: ['A.'], next: 'N', detail: [] })).not.toContain('## Detail');
  });
});

const summary = (
  kind: ArtifactSummary['kind'],
  commitSha: string | null = null,
): ArtifactSummary => ({
  globId: 's1t1',
  kind,
  label: '',
  version: 1,
  versions: 1,
  commitSha,
  createdAt: NOW,
  by: 'sessionator',
  actor: 'a@example.com',
});

describe('resumePhase', () => {
  it('maps what was uploaded to the phase to resume from', () => {
    expect(resumePhase([], HEAD)).toBe(1);
    expect(resumePhase([summary('plan')], HEAD)).toBe(1);
    expect(resumePhase([summary('plan'), summary('investigation')], HEAD)).toBe(3);
    expect(resumePhase([summary('investigation'), summary('implementation_plan')], HEAD)).toBe(4);
    expect(
      resumePhase([summary('implementation_plan'), summary('local_review', 'older')], HEAD),
    ).toBe(5);
    expect(resumePhase([summary('implementation_plan'), summary('local_review', HEAD)], HEAD)).toBe(
      6,
    );
    expect(resumePhase([summary('local_review', HEAD)], null)).toBe(5);
  });
});

describe('openFindings', () => {
  const source = (id: number): ReviewSource => ({
    id,
    boardId: 1,
    globId: 's1t1',
    kind: 'local_review',
    artifactId: id,
    externalId: null,
    commitSha: null,
    agentSetVersion: null,
    content: null,
    path: null,
    line: null,
    state: 'split',
    attempts: 0,
    processAfter: null,
    error: null,
    createdAt: NOW,
    version: 1,
  });
  const finding = (
    id: number,
    sourceId: number,
    patch: Partial<ReviewFinding> = {},
  ): ReviewFinding => ({
    id,
    boardId: 1,
    globId: 's1t1',
    sourceId,
    source: 'local_review',
    commitSha: null,
    agentSetVersion: null,
    severity: 'in_scope',
    round: null,
    path: null,
    line: null,
    text: 't',
    resolved: false,
    fingerprint: `f${String(id)}`,
    class: 'other',
    classNote: null,
    state: 'classified',
    attempts: 0,
    processAfter: null,
    error: null,
    createdAt: NOW,
    classifiedAt: NOW,
    version: 1,
    ...patch,
  });

  it('counts the newest review in-scope classified findings only', () => {
    const findings = [
      finding(1, 1),
      finding(2, 2),
      finding(3, 2),
      finding(4, 2, { severity: 'suggestion' }),
      finding(5, 2, { state: 'pending', class: null }),
    ];
    expect(openFindings(findings, [source(1), source(2)])).toBe(2);
    expect(openFindings(findings, [])).toBe(0);
  });

  it('does not count findings the review reports as fixed (s15b94)', () => {
    const findings = [
      finding(1, 1, { resolved: true }),
      finding(2, 1, { resolved: true }),
      finding(3, 1),
    ];
    expect(openFindings(findings, [source(1)])).toBe(1);
    expect(openFindings(findings.slice(0, 2), [source(1)])).toBe(0);
  });
});
