import { describe, expect, it } from 'vitest';
import { humanSteps, machine, machineSteps, whoseMove } from '@slop/core';
import type { Actor, Glob, Run, Status } from '@slop/core';
import { mainAction } from '../src/lib/main-action';
import { actionPresentation, presentedActions } from '../src/lib/action-presentation';
import { NOW, glob, run } from '../../../packages/core/test/fixtures';

/**
 * The rule: in every state the viewer who can act sees a main action that advances the glob, or a machine/waiting status.
 * Never neither. The fixtures are the reachable combinations of status, type, run, PR, conflict, checks and implementer.
 */
const ME = 'me@example.com';
const ELSE = 'else@example.com';
const admin: Actor = { email: 'admin@example.com', role: 'admin' };
const dev: Actor = { email: ME, role: 'dev' };

type RunKind = 'none' | 'queued' | 'active' | 'watching' | 'ended' | 'failed' | 'conflict-ended';
const RUNS: Record<RunKind, Run | null> = {
  none: null,
  queued: run({ state: 'queued', startedAt: null, lastProgressAt: null }),
  active: run({ state: 'active' }),
  watching: run({ state: 'watching' }),
  ended: run({ state: 'ended', outcome: 'superseded', endedAt: NOW }),
  failed: run({ state: 'ended', outcome: 'failed', endedAt: NOW, failureReason: 'gave up' }),
  'conflict-ended': run({
    state: 'ended',
    outcome: 'superseded',
    endedAt: NOW,
    purpose: 'resolve_conflict',
  }),
};

const checks = {
  none: null,
  pending: { sha: 'aaa', state: 'pending' as const, at: NOW },
  passed: { sha: 'aaa', state: 'passed' as const, at: NOW },
  failed: { sha: 'aaa', state: 'failed' as const, at: NOW },
};

interface Fixture {
  readonly name: string;
  readonly glob: Glob;
}

const fixtures = (): Fixture[] => {
  const out: Fixture[] = [];
  const add = (name: string, patch: Partial<Glob>, runKind: RunKind) => {
    const r = RUNS[runKind];
    out.push({
      name: `${name} / run ${runKind}`,
      glob: glob({ updatedAt: NOW, ...patch, runs: r === null ? [] : [r] }),
    });
  };
  const implementers: (string | null)[] = [null, ME, ELSE];
  for (const type of ['sub', 'same', 'super'] as const) {
    for (const implementer of implementers) {
      // A super always has an implementer (its creator); slop's own run only ever works a glob nobody picked up.
      if (type === 'super' && implementer === null) continue;
      const who = `${type} impl=${implementer ?? 'none'}`;
      // Planning: nobody on it yet (a super is picked up, a same started or picked up).
      if (type !== 'sub' && implementer === null)
        add(`${who} planning`, { type, status: 'planning', pr: null }, 'none');
      // Implementing: the machine's run (queued or active) on a draft PR.
      if (type !== 'super' && implementer === null) {
        for (const k of ['queued', 'active'] as const)
          add(`${who} implementing`, { type, status: 'implementing' }, k);
      }
      // In progress: a person on it, no live machine run.
      if (implementer !== null) {
        for (const k of ['none', 'ended', 'failed'] as const) {
          for (const pr of [null, { number: 7, state: 'draft' as const, headSha: 'aaa' }]) {
            add(
              `${who} in_progress pr=${pr === null ? 'none' : 'draft'}`,
              { type, status: 'in_progress', implementer, pr },
              k,
            );
          }
        }
      }
      // PR open: ready PR, conflict or not, every checks state.
      // A person on the glob has superseded any live run, so only a machine-owned glob has one.
      const prRuns: RunKind[] =
        implementer === null
          ? ['none', 'watching', 'ended', 'failed', 'conflict-ended', 'queued', 'active']
          : ['none', 'ended', 'failed', 'conflict-ended'];
      for (const k of prRuns) {
        for (const conflict of [false, true]) {
          for (const [c, headChecks] of Object.entries(checks)) {
            // Only a run that gave up leaves `failure` on the PR.
            for (const failure of k === 'failed'
              ? [null, { reason: 'gave up', at: NOW }]
              : [null]) {
              add(
                `${who} pr_open conflict=${String(conflict)} checks=${c} failure=${String(failure !== null)}`,
                {
                  type,
                  status: 'pr_open',
                  implementer,
                  pr: { number: 7, state: 'ready', headSha: 'aaa' },
                  headChecks,
                  failure,
                  conflict: conflict ? { base: 'main', since: NOW, at: NOW, files: [] } : null,
                },
                k,
              );
            }
          }
        }
      }
      // Failed: the run gave up, or the PR conflicted at merge.
      if (type !== 'super' || implementer !== null) {
        for (const kind of [undefined, 'merge' as const]) {
          for (const k of ['ended', 'failed'] as const) {
            add(
              `${who} failed kind=${kind ?? 'run'}`,
              {
                type,
                status: 'failed',
                implementer,
                failure: { reason: 'it broke', at: NOW, ...(kind && { kind }) },
              },
              k,
            );
          }
        }
      }
    }
  }
  return out;
};

/** Who looks at the glob: its implementer, else an admin (the planner may be a person who can't act on it). */
const viewerOf = (g: Glob): { actor: Actor; email: string } => {
  if (g.implementer !== null)
    return {
      actor: g.implementer === ME ? dev : { email: g.implementer, role: 'dev' },
      email: g.implementer,
    };
  return { actor: admin, email: admin.email };
};

const SHOWN_STATUSES: readonly Status[] = [
  'planning',
  'implementing',
  'in_progress',
  'pr_open',
  'failed',
];

describe('no dead ends', () => {
  const all = fixtures();

  it('covers every status the glob view acts on', () => {
    for (const status of SHOWN_STATUSES)
      expect(
        all.some((f) => f.glob.status === status),
        status,
      ).toBe(true);
  });

  it.each(all.map((f) => [f.name, f.glob] as const))(
    '%s has a main action or a machine/waiting status',
    (_name, g) => {
      const { actor, email } = viewerOf(g);
      const shown = presentedActions(machine.allowedActions(g, actor)).filter(
        (a) => a !== 'delete' && actionPresentation(a, g, false, email).placement !== 'none',
      );
      const main = mainAction(shown, g, false, false, email);
      const move = whoseMove(g, humanSteps(g, {}, []), machineSteps(g), [], NOW, {
        viewer: { email, role: actor.role },
      });
      const status = move.holder === 'machine' || move.holder === 'waiting';
      expect(
        main !== null || (status && move.reason !== ''),
        `main=${String(main)} holder=${move.holder} (${move.reason}) shown=${shown.join(',')}`,
      ).toBe(true);
    },
  );

  it('offers an implementer Resume on their own glob with nothing running (s15t117)', () => {
    const g = glob({
      type: 'same',
      status: 'pr_open',
      implementer: ME,
      pr: { number: 7, state: 'ready', headSha: 'aaa' },
      conflict: { base: 'main', since: NOW, at: NOW, files: [] },
      runs: [RUNS['conflict-ended'] as Run],
    });
    const actions = presentedActions(machine.allowedActions(g, dev));
    expect(actions).toContain('pick_up');
    expect(mainAction(actions, g, false, false, ME)).toBe('pick_up');
    expect(actionPresentation('pick_up', g, false, ME).label).toBe('Resume');
    // Anyone else taking it over is not the main step.
    expect(actionPresentation('pick_up', g, false, ELSE).label).toBe('Pick up');
  });
});
