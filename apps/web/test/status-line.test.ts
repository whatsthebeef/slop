import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import {
  blockedLine,
  blockedParts,
  dependencySummary,
  mergeWarning,
  statusLine,
  viewStatusLine,
  waitingFor,
} from '../src/lib/status-line';
import { onStandby, positionOf } from '../src/lib/position';
import { NOW, glob, run } from '../../../packages/core/test/fixtures';

const head = 'd16d563aaaa';
const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const prOpen = (patch: Partial<GlobView> = {}) =>
  view({ status: 'pr_open', pr: { number: 7, state: 'ready', headSha: head }, ...patch });
const failedChecks = {
  sha: head,
  state: 'failed' as const,
  failure: {
    name: 'Type check',
    step: null,
    lines: ['packages/core typecheck: TS2322 not assignable'],
    url: 'https://github.com/x/y/actions/runs/1',
  },
};
const top = (g: GlobView, role: 'dev' | 'qa' = 'dev') => {
  const actions = g.allowedActions ?? [];
  return viewStatusLine(g, NOW, waitingFor(g, actions, role));
};

describe('needs_pairing failure', () => {
  it('says which decision needs a person, and falls back to the reason', () => {
    const failed = (decision?: string) =>
      view({
        status: 'failed',
        list: 'doing',
        failure: {
          reason: 'Gave up',
          at: NOW,
          kind: 'needs_pairing',
          ...(decision === undefined ? {} : { decision }),
        },
      });
    expect(JSON.stringify(top(failed('Which storage to use?')))).toContain(
      'Needs a person: Which storage to use?',
    );
    expect(JSON.stringify(top(failed()))).toContain('Needs a person: Gave up');
  });
});

describe('shared status line', () => {
  it('shows checks failed on a sub in the card and the view alike, linking the run and the routine fixing it', () => {
    const g = prOpen({
      type: 'sub',
      headChecks: failedChecks,
      runs: [run({ state: 'watching', sessionUrl: 'https://claude.ai/code/s' })],
      currentRun: run({ state: 'watching', sessionUrl: 'https://claude.ai/code/s' }),
    });
    const card = statusLine(g, NOW);
    expect(card).toMatchObject({
      kind: 'checks',
      url: failedChecks.failure.url,
      doing: 'routine session is fixing it',
      sessionUrl: 'https://claude.ai/code/s',
    });
    expect(card?.text).toMatch(/^Type check failed: packages\/core typecheck/);
    expect(top(g)).toEqual(card);
  });

  it("shows a red base as not this glob's change, and that the branch updates when fixed", () => {
    const g = prOpen({
      type: 'sub',
      headChecks: { ...failedChecks, inheritedFrom: { base: 'main', since: 's15t11' } },
    });
    const line = top(g);
    expect(line).toMatchObject({
      kind: 'base-red',
      doing: 'this branch is updated when the base is fixed',
    });
    expect(line?.full).toMatch(/not this glob's change/);
    expect(line).toEqual(statusLine(g, NOW));
  });

  it('shows a run failure', () => {
    const g = view({ status: 'failed', failure: { reason: 'Routine run failed: boom', at: NOW } });
    expect(top(g)).toMatchObject({ kind: 'failure', full: 'Routine run failed: boom' });
    expect(top(g)).toEqual(statusLine(g, NOW));
  });

  it('shows a stuck hint', () => {
    const g = prOpen({ type: 'sub', headChecks: null, updatedAt: '2026-10-05T10:00:00.000Z' });
    const card = statusLine(g, NOW);
    expect(card?.kind).toBe('stuck');
    expect(top(g)).toEqual(card);
  });

  it('shows a same that is ready as ready, with no wait', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'passed' }, allowedActions: ['merge'] });
    expect(top(g)).toMatchObject({ kind: 'ready', full: 'Merge' });
    expect(top(g)).toEqual(statusLine(g, NOW));
  });

  it('keeps waiting for checks off the status line: the position indicator carries it', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'pending' }, allowedActions: [] });
    expect(statusLine(g, NOW)).toBeNull();
    expect(top(g)).toBeNull();
    expect(positionOf(g, NOW)).toMatchObject({
      holder: 'waiting',
      text: 'checks running on d16d563',
      onChecks: true,
    });
  });

  it('says why a same with failed checks cannot merge, keeping the link', () => {
    const g = prOpen({ headChecks: failedChecks, allowedActions: [] });
    const line = top(g);
    expect(line?.full).toMatch(
      /^Merge waits: checks failed on d16d563 Type check: packages\/core typecheck/,
    );
    expect(line?.url).toBe(failedChecks.failure.url);
    expect(line?.kind).toBe('checks');
  });

  it('says a red main is why a same cannot merge', () => {
    const g = prOpen({
      headChecks: { ...failedChecks, inheritedFrom: { base: 'main', since: 's15t11' } },
      allowedActions: [],
    });
    expect(top(g)?.full).toBe('Merge waits: main is red since s15t11');
  });

  it('says a conflict with the base is why a same with passing checks cannot merge', () => {
    const g = prOpen({
      headChecks: { sha: head, state: 'passed' },
      conflict: { base: 'main', files: [], since: 's1t2', at: NOW },
      allowedActions: [],
    });
    expect(waitingFor(g, [], 'dev')).toMatchObject([
      { action: 'merge', why: ': conflicts with main' },
    ]);
  });

  it('says a super waits for the implementation record', () => {
    const g = view({
      type: 'super',
      status: 'pr_open',
      pr: { number: 7, state: 'ready', headSha: head },
      headChecks: { sha: head, state: 'passed' },
      allowedActions: ['merge'],
    });
    expect(top(g)?.full).toBe(
      'Merge & keep working waits for the implementation record at the head',
    );
  });

  it('gives QA and PO no wait', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'pending' }, allowedActions: [] });
    expect(waitingFor(g, [], 'qa')).toEqual([]);
  });
});

describe('provisioning failure', () => {
  it('shows the reason and fix first, ahead of every other problem', () => {
    const reason =
      "Couldn't create branch s1t1 on acme/app: the slop GitHub App can't see that repo. Install it on the repo, or add the repo to its access, then Start over.";
    const g = view({
      status: 'failed',
      provisioning: 'failed',
      failure: { reason, at: NOW, kind: 'provisioning' },
      headChecks: failedChecks,
    });
    const line = statusLine(g, NOW);
    expect(line).toMatchObject({ kind: 'provisioning', full: reason });
    expect(line?.tip).not.toContain('the routine run failed');
    expect(top(g)).toMatchObject({ kind: 'provisioning', full: reason });
  });
});

describe('position indicator', () => {
  const withRun = (state: 'queued' | 'active' | 'watching', patch = {}, over: Partial<GlobView> = {}) => {
    const r = run({ state, ...patch });
    return view({ runs: [r], currentRun: r, ...over });
  };
  const later = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

  it('shows nothing when no run is live and nobody has stalled the glob', () => {
    expect(positionOf(view({ status: 'planning', list: 'planning' }), NOW)).toBeNull();
    expect(positionOf(view({ status: 'planning', list: 'planning', runs: [run({ state: 'ended' })], currentRun: run({ state: 'ended' }) }), NOW)).toBeNull();
  });

  it('says a picked-up glob has no machine run, then stalls it once it sits too long, and not while a run is live', () => {
    const picked = view({ status: 'in_progress', implementer: 'dev@example.com', updatedAt: NOW, currentRun: null, runs: [] });
    expect(positionOf(picked, NOW)).toMatchObject({ holder: 'human', text: 'picked up, no machine run' });
    expect(positionOf(picked, later(60))).toMatchObject({ holder: 'stalled' });
    expect(positionOf(withRun('active', {}, { status: 'in_progress', implementer: 'dev@example.com' }), later(1))).toMatchObject({
      holder: 'machine',
      text: 'implementing',
    });
  });

  it("labels slop's agent-set glob by what slop did, not as picked up with no session", () => {
    const agentSet = view({
      title: 'Agent set v58',
      category: 'task',
      type: 'same',
      status: 'in_progress',
      implementer: 'slop',
      updatedAt: NOW,
      currentRun: null,
      runs: [],
    });
    expect(positionOf(agentSet, later(30))).toMatchObject({ holder: 'machine', text: 'committing agent set v58' });
  });

  it('puts merging when checks pass ahead of the plain checks wait', () => {
    const armed = prOpen({ headChecks: { sha: head, state: 'pending' }, mergeMode: 'when_green', allowedActions: ['cancel_merge'] });
    expect(positionOf(armed, NOW)).toMatchObject({ holder: 'waiting', text: 'merging when checks pass', spinning: true });
    expect(waitingFor(armed, armed.allowedActions ?? [], 'dev')).toEqual([]);
    const settled = { ...armed, headChecks: { sha: head, state: 'passed' as const } };
    expect(positionOf(settled, NOW)).toMatchObject({ holder: 'machine', text: 'merging' });
  });

  it('says a ready PR is waiting for checks before they have started', () => {
    expect(positionOf(prOpen({ headChecks: null }), NOW)).toMatchObject({
      holder: 'waiting',
      text: 'checks running on d16d563',
      spinning: false,
    });
  });

  it('shows a run on standby as a muted marker that holds nothing', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'passed' }, allowedActions: ['merge'], runs: [run({ state: 'watching' })], currentRun: run({ state: 'watching' }) });
    expect(onStandby(g)).not.toBeNull();
    expect(positionOf(g, NOW)?.holder).not.toBe('machine');
  });

  it('names the run states', () => {
    expect(positionOf(withRun('active', {}, { status: 'in_progress' }), NOW)?.text).toBe('implementing');
    expect(positionOf(withRun('queued', {}, { status: 'in_progress' }), NOW)?.text).toBe('queued');
  });

  it('says how long a run has been queued', () => {
    const g = withRun('queued', { queuedAt: NOW }, { status: 'in_progress' });
    expect(positionOf(g, later(3))?.text).toBe('queued 3 min');
    expect(positionOf(g, later(3))?.tip).toMatch(/^Machine run queued/);
  });

  it('stalls a run that has been queued past the threshold, in the warning tone', () => {
    const g = withRun('queued', { queuedAt: NOW, lastProgressAt: NOW }, { status: 'in_progress' });
    expect(positionOf(g, later(25))).toMatchObject({ holder: 'stalled', tone: 'text-required' });
    expect(positionOf(g, later(25))?.text).toMatch(/^stalled: queued for 25 min/);
  });

  it('names what a run on an open PR is fixing', () => {
    const open = (state: 'passed' | 'failed') =>
      withRun('active', {}, { status: 'pr_open', pr: { number: 7, state: 'ready', headSha: head }, headChecks: { sha: head, state } });
    expect(positionOf(open('failed'), NOW)).toMatchObject({ holder: 'machine', text: 'fixing CI' });
    expect(positionOf(open('passed'), NOW)).toMatchObject({ holder: 'machine', text: 'implementing' });
  });

  it('shows nothing once the checks have settled, and leaves problems to the status line', () => {
    expect(positionOf(prOpen({ headChecks: { sha: head, state: 'passed' }, allowedActions: ['merge'] }), NOW)).toBeNull();
    const failed = prOpen({ headChecks: failedChecks });
    expect(statusLine(failed, NOW)?.kind).toBe('checks');
  });

  it("prefers the server's move over deriving one", () => {
    const g = view({ move: { holder: 'waiting', reason: 'waiting on s15f82', since: null, waitingOn: ['s15f82'] } });
    expect(positionOf(g, NOW)).toMatchObject({ holder: 'waiting', text: 'waiting on s15f82' });
  });
});

describe('investigate runs', () => {
  const planning = (r: ReturnType<typeof run>) =>
    view({ status: 'planning', list: 'planning', runs: [r], currentRun: r });

  it('says investigating while queued or active, never started or working', () => {
    for (const state of ['queued', 'active'] as const) {
      const label = positionOf(
        planning(run({ state, purpose: 'investigate', sessionUrl: 'https://claude.ai/code/s', queuedAt: NOW })),
        NOW,
      );
      expect(label?.holder).toBe('machine');
      expect(label?.text).toBe(state === 'queued' ? 'queued' : 'investigating');
      expect(label?.sessionUrl).toBe('https://claude.ai/code/s');
    }
  });

  it('shows nothing run-like once a completed investigation has ended', () => {
    const g = planning(run({ state: 'ended', outcome: 'completed', purpose: 'investigate' }));
    expect(positionOf(g, NOW)).toBeNull();
    expect(statusLine(g, NOW)).toBeNull();
  });

  it('shows a failed investigation as a muted note with the reason, not a red failure', () => {
    const line = statusLine(
      planning(
        run({
          state: 'ended',
          outcome: 'failed',
          failureReason: 'No progress',
          purpose: 'investigate',
        }),
      ),
      NOW,
    );
    expect(line?.kind).toBe('investigation-failed');
    expect(line?.full).toBe('Investigation failed: No progress');
    expect(line?.tone).not.toBe('text-red');
  });

  it('leaves an implementation run unchanged', () => {
    const r = run({ state: 'active' });
    expect(positionOf(view({ status: 'in_progress', runs: [r], currentRun: r }), NOW)?.text).toBe('implementing');
    expect(
      statusLine(
        view({ currentRun: run({ state: 'ended', outcome: 'failed', failureReason: 'x' }) }),
        NOW,
      )?.kind,
    ).not.toBe('investigation-failed');
  });
});

describe('blocked line', () => {
  const ahead = (ids: string[], nextStartable: string | null = null) =>
    view({
      blockedBy: ids.map((id, i) => ({
        id,
        state: 'open' as const,
        status: 'implementing' as const,
        depth: i + 1,
      })),
      nextStartable,
    });

  it('names one or two blockers', () => {
    expect(blockedLine(ahead(['s1t1']))).toBe('blocked by s1t1');
    expect(blockedLine(ahead(['s1t1', 's1t2']))).toBe('blocked by s1t1, s1t2');
  });

  it('folds three or more into two names and a count', () => {
    expect(blockedLine(ahead(['s1t1', 's1t2', 's1t3', 's1t4']))).toBe('blocked by s1t1, s1t2 +2');
  });

  it('lists direct prerequisites before transitive ones', () => {
    const g = view({
      blockedBy: [
        { id: 's1t3', state: 'open', status: 'implementing', depth: 2 },
        { id: 's1t1', state: 'open', status: 'implementing', depth: 1 },
      ],
    });
    expect(blockedParts(g)?.ids).toEqual(['s1t1', 's1t3']);
  });

  it('appends the glob to start next unless it is already named', () => {
    expect(blockedLine(ahead(['s1t1', 's1t2', 's1t3'], 's1t3'))).toBe(
      'blocked by s1t1, s1t2, s1t3',
    );
    expect(blockedLine(ahead(['s1t1', 's1t2', 's1t3', 's1t4'], 's1t4'))).toBe(
      'blocked by s1t1, s1t2 +2 · next: s1t4',
    );
  });

  it('is null with nothing ahead', () => {
    expect(blockedLine(view())).toBeNull();
  });
});

describe('dependency summary', () => {
  it('is null with nothing to list', () => {
    expect(dependencySummary(view())).toBeNull();
  });

  it('shows a direct need with its status and why, and the chain behind it as also ahead', () => {
    const summary = dependencySummary(
      view({
        waitingFor: [{ id: 's1t1', state: 'open', why: 'Waits for s1t1 to merge' }],
        blockedBy: [
          { id: 's1t1', state: 'open', status: 'implementing', depth: 1 },
          { id: 's1t0', state: 'planning', status: 'planning', depth: 2 },
        ],
      }),
    );
    expect(summary?.needs).toEqual([
      { id: 's1t1', status: 'Doing', why: 'Waits for s1t1 to merge' },
    ]);
    expect(summary?.alsoAhead.map((b) => b.id)).toEqual(['s1t0']);
  });

  it('lists overlaps and waited-on-by globs', () => {
    const summary = dependencySummary(
      view({
        edges: [
          { id: 's1t5', kind: 'overlaps', source: 'explicit', paths: ['a.ts'] },
          { id: 's1t6', kind: 'needs', source: 'explicit', paths: [] },
        ],
        waitedOnBy: ['s1t9'],
      }),
    );
    expect(summary?.overlaps.map((e) => e.id)).toEqual(['s1t5']);
    expect(summary?.waitedOnBy).toEqual(['s1t9']);
  });
});

describe('your turn from human steps', () => {
  const dev = { email: 'dev@example.com', role: 'dev' } as const;
  const step = (patch = {}) => ({ id: 'hs-1', kind: 'rollout', title: 'Deploy the host stack', state: 'due', who: 'admin', due: 'now', blocks: [], ...patch }) as const;

  it('a stalled glob shows its action as the label and the cause in the tooltip', () => {
    const stalled = view({
      status: 'in_progress',
      list: 'doing',
      move: { holder: 'stalled', cause: 'quiet', reason: 'implement: no progress for 60 min', since: null },
      humanSteps: [step({ id: 'machine:unstick', kind: 'unstick', title: 'Open session', who: 'implementer', action: 'open_session', alternative: 'pick_up' })],
    });
    const line = statusLine(stalled, NOW, { email: glob().planner, role: 'dev' });
    expect(line).toMatchObject({ kind: 'ready', text: 'Open session', turn: 'unstick', action: 'open_session' });
    expect(line?.tip).toContain('Implement: no progress for 60 min');
    expect(line?.tip).toContain('glob view');
  });

  it('cuts a long step title to one line for the chip, keeping the whole in the tooltip', () => {
    const long = view({ status: 'reviewing', humanSteps: [step({ title: 'Tell the whole team about the new deploy process', who: 'admin' })] });
    const line = statusLine(long, NOW, { email: 'admin@example.com', role: 'admin' });
    expect(line?.text.length).toBeLessThanOrEqual(24);
    expect(line?.tip).toBe('Tell the whole team about the new deploy process');
  });

  it('shows the first due step for the viewer, with the Merge tip for a merge step', () => {
    const merge = prOpen({ headChecks: { sha: head, state: 'passed' }, humanSteps: [{ ...step({ id: 'machine:merge', kind: 'merge', title: 'Merge', who: 'anyone' }) }] });
    const line = statusLine(merge, NOW, dev);
    expect(line).toMatchObject({ kind: 'ready', text: 'Merge' });
    expect(line?.tip).toContain('checks passed');
    const rollout = view({ status: 'reviewing', humanSteps: [step({ who: 'admin' }), step({ id: 'hs-2', who: 'implementer', title: 'Tell the team' })] });
    expect(statusLine(rollout, NOW, { email: glob().planner, role: 'dev' })).toMatchObject({ kind: 'ready', text: 'Tell the team' });
    expect(statusLine(rollout, NOW, { email: 'admin@example.com', role: 'admin' })).toMatchObject({ kind: 'ready', text: 'Deploy the host stack' });
  });

  it('is not your turn for a pending step or one that is for someone else', () => {
    expect(statusLine(view({ humanSteps: [step({ state: 'pending' })] }), NOW, dev)).toBeNull();
    expect(statusLine(view({ humanSteps: [step({ who: 'admin' })] }), NOW, dev)).toBeNull();
  });

  it('falls back to the Merge turn when the API sends no steps', () => {
    const merge = prOpen({ headChecks: { sha: head, state: 'passed' } });
    expect(statusLine(merge, NOW, dev)).toMatchObject({ kind: 'ready', text: 'Merge' });
  });
});

describe('mergeWarning', () => {
  const behind = { base: 'main', behindBy: 2, files: ['a.ts'], at: NOW };
  it('warns on a pr_open glob whose base moved with no conflict recorded', () => {
    expect(mergeWarning(prOpen({ behind }))).toContain('main has moved since the checks ran');
  });
  it('says nothing when the branch is level, a conflict is recorded, or the glob is not in review', () => {
    expect(mergeWarning(prOpen({ behind: { ...behind, behindBy: 0 } }))).toBeNull();
    expect(mergeWarning(prOpen())).toBeNull();
    expect(mergeWarning(prOpen({ behind, conflict: { base: 'main', files: [], since: null, at: NOW } }))).toBeNull();
    expect(mergeWarning(view({ status: 'in_progress', behind }))).toBeNull();
  });
});
