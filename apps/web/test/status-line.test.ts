import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import {
  activityLabel,
  blockedLine,
  blockedParts,
  dependencySummary,
  statusLine,
  viewStatusLine,
  waitingFor,
} from '../src/lib/status-line';
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

  it('keeps waiting for checks off the status line: the activity label carries it', () => {
    const g = prOpen({ headChecks: { sha: head, state: 'pending' }, allowedActions: [] });
    expect(statusLine(g, NOW)).toBeNull();
    expect(top(g)).toBeNull();
    expect(activityLabel(g, NOW)).toMatchObject({
      kind: 'checks',
      text: 'Checks running on d16d563',
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

describe('activity label', () => {
  const live = (state: 'queued' | 'active' | 'watching', patch = {}) => ({
    currentRun: run({ state, ...patch }),
  });

  it('is null when nothing runs on its own', () => {
    expect(activityLabel(view(), NOW)).toBeNull();
    expect(activityLabel(view({ currentRun: run({ state: 'ended' }) }), NOW)).toBeNull();
  });

  it('says a picked-up glob has no session once it has sat untouched, and not while a run is live', () => {
    const later = new Date(Date.parse(NOW) + 30 * 60_000).toISOString();
    const picked = view({
      status: 'in_progress',
      implementer: 'dev@example.com',
      updatedAt: NOW,
      currentRun: null,
    });
    expect(activityLabel(picked, NOW)).toBeNull();
    expect(activityLabel(picked, later)).toMatchObject({
      kind: 'picked_up',
      text: 'picked up, no machine run',
    });
    expect(activityLabel({ ...picked, ...live('active') }, later)?.kind).toBe('working');
  });

  it("labels slop's agent-set glob by what slop did, not as picked up with no session", () => {
    const later = new Date(Date.parse(NOW) + 30 * 60_000).toISOString();
    const agentSet = view({
      title: 'Agent set v58',
      category: 'task',
      type: 'same',
      status: 'in_progress',
      implementer: 'slop',
      updatedAt: NOW,
      currentRun: null,
    });
    expect(activityLabel(agentSet, later)).toMatchObject({
      kind: 'agent_set',
      text: "Waiting for slop's commit",
    });
    const open = {
      ...agentSet,
      status: 'pr_open' as const,
      pr: { number: 3, state: 'ready' as const, headSha: head },
      headChecks: { sha: head, state: 'passed' as const },
    };
    expect(activityLabel(open, later)).toMatchObject({
      kind: 'agent_set',
      text: 'Slop committed agent set v58: review and merge',
    });
    expect(
      activityLabel({ ...open, headChecks: { sha: head, state: 'failed' as const } }, later),
    ).toBeNull();
  });

  it('puts merging over checks over the run', () => {
    const base = prOpen({ headChecks: { sha: head, state: 'pending' }, ...live('watching') });
    expect(activityLabel(base, NOW)?.kind).toBe('checks');
    expect(activityLabel({ ...base, status: 'merging' }, NOW)?.text).toBe('Merging');
  });

  it('puts checks over the run, and says waiting before the checks have started', () => {
    expect(activityLabel(prOpen({ headChecks: null, ...live('active') }), NOW)).toMatchObject({
      kind: 'checks',
      text: 'Waiting for checks on d16d563',
    });
  });

  it('names the run states', () => {
    expect(activityLabel(view(live('active')), NOW)?.text).toBe('working');
    expect(activityLabel(view(live('watching')), NOW)?.text).toBe('standby');
    expect(activityLabel(view(live('queued')), NOW)?.text).toBe('queued');
  });

  it('says how long a run has been queued past 10 minutes', () => {
    const later = new Date(Date.parse(NOW) + 25 * 60_000).toISOString();
    const g = view(live('queued', { queuedAt: NOW }));
    expect(activityLabel(g, later)?.text).toBe('queued for 25 min');
    expect(activityLabel(g, later)?.tip).toMatch(/^Machine run queued for 25 min/);
    expect(activityLabel(view(live('queued')), NOW)?.tip).toMatch(/^Machine run queued/);
  });

  it('shows nothing once the checks have settled, and leaves problems to the status line', () => {
    expect(activityLabel(prOpen({ headChecks: { sha: head, state: 'passed' } }), NOW)).toBeNull();
    const failed = prOpen({ headChecks: failedChecks });
    expect(activityLabel(failed, NOW)).toBeNull();
    expect(statusLine(failed, NOW)?.kind).toBe('checks');
  });
});

describe('investigate runs', () => {
  const planning = (r: ReturnType<typeof run>) =>
    view({ status: 'planning', list: 'planning', runs: [r], currentRun: r });

  it('says Investigating while queued or active, never started or working', () => {
    for (const state of ['queued', 'active'] as const) {
      const label = activityLabel(
        planning(run({ state, purpose: 'investigate', sessionUrl: 'https://claude.ai/code/s' })),
        NOW,
      );
      expect(label?.kind).toBe('investigating');
      expect(label?.text).toBe('Investigating');
      expect(label?.tip).toContain('https://claude.ai/code/s');
    }
  });

  it('shows nothing run-like once a completed investigation has ended', () => {
    const g = planning(run({ state: 'ended', outcome: 'completed', purpose: 'investigate' }));
    expect(activityLabel(g, NOW)).toBeNull();
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
    expect(activityLabel(view({ currentRun: run({ state: 'active' }) }), NOW)?.kind).toBe(
      'working',
    );
    expect(activityLabel(view({ currentRun: run({ state: 'queued' }) }), NOW)?.kind).toBe('queued');
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
