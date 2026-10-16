import { describe, expect, it } from 'vitest';
import { CARD_ACTION_KINDS, PENDING_TIMEOUT_MS, presentGlob } from '../src/index.js';
import type {
  Action,
  HumanStepViewer,
  ListedHumanStep,
  PresentableGlob,
  PresentationFacts,
} from '../src/index.js';
import { NOW, glob, run } from './fixtures.js';

const HEAD = 'd16d563aaaa';
const FILES = ['apps/web/src/lib/api.ts'];
const MINUTE = 60_000;
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();

const view = (patch: Partial<PresentableGlob> = {}): PresentableGlob => ({
  ...glob(),
  list: 'doing',
  branch: 's1t1',
  currentRun: null,
  allowedActions: [],
  ...patch,
});
const prOpen = (patch: Partial<PresentableGlob> = {}): PresentableGlob =>
  view({
    type: 'same',
    status: 'pr_open',
    pr: { number: 7, state: 'ready', headSha: HEAD },
    headChecks: { sha: HEAD, state: 'passed' },
    ...patch,
  });
const conflict = { base: 'main', files: FILES, since: 's1t9', at: ago(5 * MINUTE) };
const failedChecks = {
  sha: HEAD,
  state: 'failed' as const,
  at: ago(10 * MINUTE),
  failure: {
    name: 'Type check',
    step: null,
    lines: ['packages/core typecheck: TS2322 not assignable'],
    url: 'https://github.com/x/y/actions/runs/1',
  },
};
const viewer: HumanStepViewer = { email: 'dev@example.com', role: 'dev' };

const present = (g: PresentableGlob, extra: Partial<PresentationFacts> = {}) =>
  presentGlob({ glob: g, now: NOW, viewer, ...extra });

/** The rules that hold for every glob, whatever its state. */
const holdsRules = (g: PresentableGlob, extra: Partial<PresentationFacts> = {}) => {
  const p = present(g, extra);
  // The status is text and an icon: at most a section to open, never an action or a link.
  if (p.status?.click != null)
    expect(
      Object.keys(p.status.click).every((k) => ['section', 'artifact', 'label', 'tab'].includes(k)),
    ).toBe(true);
  // The card offers one of four actions and never anything else.
  if (p.cardPrimary !== null) {
    expect(CARD_ACTION_KINDS).toContain(p.cardPrimary.kind);
    expect(['Pick up', 'Start', 'Merge', 'Fix conflict', 'Start after investigation']).toContain(
      p.cardPrimary.label,
    );
    expect(p.primary === p.cardPrimary.action || p.primary === null).toBe(true);
  }
  // Blocks are Answer, Decide and Do only, and a conflict or failed checks never make one.
  for (const b of p.blocks) expect(['answer', 'decide', 'do']).toContain(b.kind);
  if (g.conflict != null || g.headChecks?.state === 'failed') {
    expect(p.blocks).toEqual([]);
  }
  // No click in flight: no "looks stuck" line apart from the one notice, and the notice carries no second problem.
  if (p.pending !== null) {
    expect(p.primary).toBeNull();
    expect(p.cardPrimary).toBeNull();
    expect(p.notice).toBeNull();
    expect(p.status?.icon).toBe('machine-spinning');
  }
  // The PR line never says ready for review beside a conflict or failed head checks.
  const prLine = p.activity.find((e) => e.id.startsWith('pr:') && !e.id.endsWith(':merged'));
  if (
    prLine !== undefined &&
    (g.conflict != null || (g.headChecks?.state === 'failed' && g.headChecks.sha === g.pr?.headSha))
  ) {
    expect(prLine.text).not.toContain('ready for review');
  }
  return p;
};

describe('conflict, with and without failed checks', () => {
  const conflicted = () => prOpen({ conflict, allowedActions: ['resolve_conflict'] });

  it('says the conflict once, with its files, and leads with Fix conflict on the glob view and the card', () => {
    const p = holdsRules(conflicted());
    expect(p.notice).toMatchObject({ kind: 'conflict', files: FILES });
    expect(p.notice?.text).toMatch(/^Conflicts with main\./);
    expect(p.notice?.text).toContain('Checks will re-run once it is fixed');
    expect(p.primary).toBe('resolve_conflict');
    expect(p.cardPrimary).toMatchObject({
      kind: 'resolve_conflict',
      label: 'Fix conflict',
      confirm: true,
    });
    expect(p.status?.text).toBe('conflicts with main');
    expect(p.blocks).toEqual([]);
  });

  it('does not say the failed checks a conflict explains', () => {
    const p = holdsRules(
      prOpen({ conflict, headChecks: failedChecks, allowedActions: ['resolve_conflict'] }),
    );
    expect(p.notice?.kind).toBe('conflict');
    expect(p.notice?.text).not.toMatch(/Type check|checks failed/i);
    expect(p.status?.text).toBe('conflicts with main');
    expect(p.status?.text).not.toBe('checks failed');
  });

  it('says failed checks when no conflict explains them, as a notice, a Fix checks primary and no card button', () => {
    const p = holdsRules(prOpen({ headChecks: failedChecks, allowedActions: ['retry_autofix'] }));
    expect(p.notice).toMatchObject({ kind: 'checks', url: failedChecks.failure.url });
    expect(p.notice?.text).toContain('Type check failed');
    expect(p.primary).toBe('retry_autofix');
    expect(p.cardPrimary).toBeNull();
    expect(p.status?.text).toBe('checks failed');
    expect(p.blocks).toEqual([]);
  });

  describe('a failed branch build', () => {
    const buildFailed = {
      deployId: 'dep-1',
      environment: 'dev1',
      sha: 'abc1234def',
      error: 'CodeBuild failed in BUILD: COMMAND_EXECUTION_ERROR: exit 1',
      at: ago(2 * MINUTE),
      logUrl: 'https://console.aws.example/build/1',
      label: 'Build log (dev1, failed, abc1234)',
    };

    it('says it in a red notice with the log link, a build failed status with the alert icon, a Retry primary and a red activity entry', () => {
      const p = holdsRules(prOpen({ buildFailed, allowedActions: ['retry_autofix'] }));
      expect(p.notice).toMatchObject({ kind: 'build-failed', url: buildFailed.logUrl });
      expect(p.notice?.text).toBe('Build failed on dev1: CodeBuild failed in BUILD: COMMAND_EXECUTION_ERROR: exit 1');
      expect(p.status).toMatchObject({ text: 'build failed', icon: 'alert', tone: 'text-red' });
      expect(p.primary).toBe('retry_autofix');
      // The card offers nothing extra: its actions stay Pick up, Start, Merge and Fix conflict.
      expect(p.cardPrimary).toBeNull();
      expect(p.activity.find((e) => e.id === 'build:dep-1')).toMatchObject({ actor: 'warn', link: buildFailed.logUrl, linkLabel: 'build log', at: buildFailed.at });
    });

    it('says nothing once the glob has no failed build to show (someone acted, or a later deploy succeeded)', () => {
      const p = holdsRules(prOpen({ buildFailed: null }));
      expect(p.notice).toBeNull();
      expect(p.status?.text).not.toBe('build failed');
      expect(p.activity.some((e) => e.id.startsWith('build:'))).toBe(false);
    });
  });

  it('keeps the conflict of a failed merge, with its files, as the one notice', () => {
    const p = holdsRules(
      view({
        status: 'failed',
        pr: { number: 7, state: 'ready', headSha: HEAD },
        failure: {
          reason: `Merge conflict with main in ${FILES.join(', ')}`,
          at: NOW,
          kind: 'merge',
          conflict: { base: 'main', files: FILES },
        },
        allowedActions: ['resolve_conflict'],
      }),
    );
    expect(p.notice).toMatchObject({ kind: 'conflict', files: FILES });
    expect(p.cardPrimary).toMatchObject({ kind: 'resolve_conflict' });
  });

  it('never Pick up for a conflict, even on a glob someone picked up', () => {
    const p = holdsRules(
      prOpen({
        conflict,
        implementer: 'dev@example.com',
        allowedActions: ['resolve_conflict', 'take_over'],
      }),
    );
    expect(p.cardPrimary?.kind).toBe('resolve_conflict');
  });
});

describe('a run for each purpose', () => {
  const queued = (purpose?: 'resolve_conflict') =>
    run({
      state: 'queued',
      queuedAt: ago(MINUTE),
      startedAt: null,
      lastProgressAt: null,
      ...(purpose === undefined ? {} : { purpose }),
    });
  const running = (purpose?: 'resolve_conflict') =>
    run({
      state: 'active',
      startedAt: ago(2 * MINUTE),
      lastProgressAt: ago(MINUTE),
      ...(purpose === undefined ? {} : { purpose }),
    });
  const failed = (purpose?: 'resolve_conflict') =>
    run({
      state: 'ended',
      outcome: 'failed',
      endedAt: ago(MINUTE),
      failureReason: 'The run failed: boom',
      ...(purpose === undefined ? {} : { purpose }),
    });

  it('a queued or running conflict fix shows the machine at work: no notice, no button', () => {
    for (const r of [queued('resolve_conflict'), running('resolve_conflict')]) {
      const p = holdsRules(
        prOpen({ conflict, currentRun: r, runs: [r], allowedActions: ['resolve_conflict'] }),
      );
      expect(p.status?.icon).toMatch(/^machine/);
      expect(p.status?.text).toMatch(/starting|queued|fixing the conflict/);
      expect(p.notice).toBeNull();
    }
  });

  it('a running conflict fix spins', () => {
    const r = running('resolve_conflict');
    const p = present(prOpen({ conflict, currentRun: r, runs: [r] }));
    expect(p.status).toMatchObject({ icon: 'machine-spinning', text: 'fixing the conflict' });
  });

  it('a failed conflict fix leaves the conflict in the notice and Fix conflict to try again', () => {
    const r = failed('resolve_conflict');
    const p = holdsRules(
      prOpen({ conflict, currentRun: r, runs: [r], allowedActions: ['resolve_conflict'] }),
    );
    expect(p.notice?.kind).toBe('conflict');
    expect(p.cardPrimary?.kind).toBe('resolve_conflict');
  });

  it('a queued or running implementation is the machine at work', () => {
    for (const r of [queued(), running()]) {
      const g = view({
        status: 'implementing',
        currentRun: r,
        runs: [r],
        pr: null,
        allowedActions: ['take_over'],
      });
      const p = holdsRules(g);
      expect(p.status?.icon).toMatch(/^machine/);
      expect(p.notice).toBeNull();
      expect(p.cardPrimary).toBeNull();
    }
  });

  it('a failed implementation says why and never offers Pick up on the card', () => {
    const r = failed();
    const r2 = { ...failed(), id: 'run-2' };
    const g = view({
      type: 'sub',
      status: 'failed',
      runs: [r, r2],
      currentRun: r2,
      failure: { reason: 'The run failed: boom', at: NOW },
      allowedActions: ['pick_up', 'retrigger', 'start_again'],
    });
    const p = holdsRules(g);
    expect(p.notice).toMatchObject({ kind: 'failure' });
    expect(p.notice?.text).toContain('boom');
    // The glob view steps in with Pick up after repeated failures; the card has no button for it.
    expect(p.primary).toBe('pick_up');
    expect(p.cardPrimary).toBeNull();
  });

  it('a queued merge is the machine merging', () => {
    const g = prOpen({
      status: 'merging',
      mergeMode: 'when_green',
      allowedActions: ['cancel_merge'],
    });
    const p = holdsRules(g);
    expect(p.status?.text).toMatch(/merging|running checks/);
    expect(p.cardPrimary).toBeNull();
    expect(p.notice).toBeNull();
  });

  it('a failed merge says why and offers no button on the card', () => {
    const g = view({
      status: 'failed',
      pr: { number: 7, state: 'ready', headSha: HEAD },
      headChecks: { sha: HEAD, state: 'passed' },
      failure: {
        reason: 'Merge failed: GitHub refused (branch protection)',
        at: NOW,
        kind: 'merge',
      },
      allowedActions: ['retry_merge', 'start_again'],
    });
    const p = holdsRules(g);
    expect(p.notice?.kind).toBe('failure');
    expect(p.notice?.text).toContain('branch protection');
    expect(p.primary).toBe('retry_merge');
    expect(p.cardPrimary).toBeNull();
  });
});

describe('a refused merge', () => {
  const refused = () =>
    prOpen({
      allowedActions: ['merge'],
      lastOutcome: {
        kind: 'merge',
        at: NOW,
        by: 'dev@example.com',
        result: 'failed',
        reason: 'Required checks have not passed on the current head',
      },
    });

  it('says why in the notice and keeps Merge as the primary', () => {
    const p = holdsRules(refused());
    expect(p.notice).toMatchObject({ kind: 'outcome' });
    expect(p.notice?.text).toBe(
      'Merge failed: Required checks have not passed on the current head',
    );
    expect(p.primary).toBe('merge');
    expect(p.cardPrimary).toMatchObject({ kind: 'merge', label: 'Merge', confirm: true });
  });

  it('is in the activity as a failed click', () => {
    const p = present(refused());
    expect(
      p.activity.some(
        (e) => e.actor === 'warn' && e.text.startsWith('Merge failed: Required checks'),
      ),
    ).toBe(true);
  });

  it('goes away on the next click: the click is pending and the outcome is gone', () => {
    const p = holdsRules(
      prOpen({
        allowedActions: ['merge'],
        pendingAction: { kind: 'merge', at: ago(1000), by: 'dev@example.com' },
        lastOutcome: null,
      }),
    );
    expect(p.notice).toBeNull();
    expect(p.activity.some((e) => e.text === 'Dev clicked Merge')).toBe(true);
  });

  it('says a timed-out outcome as having had no effect', () => {
    const p = present(
      prOpen({
        allowedActions: ['merge'],
        lastOutcome: {
          kind: 'merge',
          at: NOW,
          by: 'dev@example.com',
          result: 'timed_out',
          reason: 'no effect',
        },
      }),
    );
    expect(p.notice?.text).toBe('Merge had no effect after a minute.');
  });
});

describe('a stuck run', () => {
  it('says it once, as the notice, with the glob view leading with a way forward', () => {
    const r = run({
      state: 'active',
      startedAt: ago(120 * MINUTE),
      lastProgressAt: ago(100 * MINUTE),
    });
    const g = view({
      type: 'sub',
      status: 'implementing',
      pr: { number: 7, state: 'draft', headSha: HEAD },
      headChecks: failedChecks,
      currentRun: r,
      runs: [r],
      updatedAt: ago(100 * MINUTE),
      allowedActions: ['take_over', 'retrigger'],
    });
    const p = holdsRules(g);
    expect(p.status?.icon).toBe('alert');
    expect(p.notice).not.toBeNull();
    // Failed checks are the notice here; "looks stuck" never joins them as a second line.
    expect(`${p.notice?.text ?? ''}${p.status?.tip ?? ''}`).not.toContain('Also:');
    expect(p.cardPrimary).toBeNull();
  });
});

describe('pending clicks', () => {
  const click = (kind: Action, at = ago(5000)) => ({ kind, at, by: 'dev@example.com' });

  it('a pending merge reads merging with the spinning machine and no primary anywhere', () => {
    const p = holdsRules(prOpen({ allowedActions: ['merge'], pendingAction: click('merge') }));
    expect(p.status).toMatchObject({ kind: 'pending', text: 'merging', icon: 'machine-spinning' });
    expect(p.primary).toBeNull();
    expect(p.cardPrimary).toBeNull();
    expect(p.notice).toBeNull();
  });

  it('a pending Fix conflict reads fixing the conflict', () => {
    const p = holdsRules(
      prOpen({
        conflict,
        allowedActions: ['resolve_conflict'],
        pendingAction: click('resolve_conflict'),
      }),
    );
    expect(p.status?.text).toBe('fixing the conflict');
    expect(p.cardPrimary).toBeNull();
    expect(p.notice).toBeNull();
  });

  it('a click this client sent shows the same way, before the glob has recorded it', () => {
    const p = holdsRules(prOpen({ allowedActions: ['merge'] }), { pending: click('merge') });
    expect(p.status?.text).toBe('merging');
    expect(p.cardPrimary).toBeNull();
  });

  it('a click that timed out gives the button back and says it had no effect', () => {
    const p = holdsRules(
      prOpen({
        allowedActions: ['merge'],
        pendingAction: click('merge', ago(PENDING_TIMEOUT_MS + 1000)),
      }),
    );
    expect(p.pending).toBeNull();
    expect(p.status?.text).not.toBe('merging');
    expect(p.notice?.text).toBe('Merge had no effect after a minute.');
    expect(p.cardPrimary?.kind).toBe('merge');
  });

  describe('an expired click whose effect is still going is not a timeout', () => {
    const old = (kind: Action) => click(kind, ago(PENDING_TIMEOUT_MS + 1000));
    const noTimeout = (p: ReturnType<typeof present>) => {
      expect(p.notice?.text ?? '').not.toContain('had no effect');
      expect(p.activity.some((e) => e.text.includes('had no effect'))).toBe(false);
    };

    it.each(['queued', 'active'] as const)('Fix conflict with its run %s says nothing', (state) => {
      const queued = run({ id: 'run-7', state, purpose: 'resolve_conflict' });
      const g = prOpen({
        conflict,
        runs: [queued],
        currentRun: queued,
        pendingAction: { ...old('resolve_conflict'), runId: 'run-7' },
      });
      noTimeout(present(g));
    });

    it('Fix conflict whose run ended without a result is a timeout', () => {
      const ended = run({
        id: 'run-7',
        state: 'ended',
        outcome: 'completed',
        purpose: 'resolve_conflict',
      });
      const g = prOpen({
        runs: [ended],
        pendingAction: { ...old('resolve_conflict'), runId: 'run-7' },
      });
      expect(present(g).notice?.text).toBe('Fix conflict had no effect after a minute.');
    });

    it.each([
      ['armed to merge when checks pass', { mergeMode: 'when_green' as const }],
      [
        'in the merge queue',
        { mergeQueue: { since: NOW, sha: HEAD, position: 2, state: 'queued' as const } },
      ],
      ['merging', { status: 'merging' as const }],
    ])('Merge %s says nothing', (_name, patch) => {
      noTimeout(present(prOpen({ ...patch, pendingAction: old('merge') })));
    });
  });

  it('every in-progress status is a status: no click action, a section at most', () => {
    for (const kind of [
      'start',
      'pick_up',
      'resolve_conflict',
      'retry_autofix',
      'merge',
      'retrigger',
    ] as const) {
      const p = holdsRules(prOpen({ pendingAction: click(kind) }));
      expect(p.status?.kind).toBe('pending');
    }
  });
});

describe('rollout steps open after the merge', () => {
  const step = (patch: Partial<ListedHumanStep> = {}): ListedHumanStep =>
    ({
      id: 'step-1',
      kind: 'rollout',
      title: 'Run the migration',
      who: 'anyone',
      state: 'due',
      due: 'after_merge',
      blocks: ['sign_off'],
      source: 'agent',
      ...patch,
    }) as ListedHumanStep;

  it('says do, asks for a Do block and raises no notice', () => {
    const g = view({
      type: 'same',
      status: 'reviewing',
      list: 'reviewing',
      pr: { number: 7, state: 'merged', headSha: HEAD },
      humanSteps: [step()],
      labels: {},
    });
    const p = holdsRules(g);
    expect(p.status?.text).toBe('do');
    expect(p.status?.tip).not.toContain('rollout open');
    expect(p.blocks).toEqual([{ kind: 'do', id: 'step-1' }]);
    expect(p.notice).toBeNull();
    expect(p.cardPrimary).toBeNull();
  });

  it('a due step for the viewer reads do, never its title, with the title and the rest in the tooltip', () => {
    const g = prOpen({
      headChecks: { sha: HEAD, state: 'passed' },
      humanSteps: [
        step({
          id: 'step-1',
          kind: 'rollout',
          title: 'Grant the role',
          due: 'once',
          blocks: ['reviewing'],
        }),
        step({ id: 'step-2', title: 'Run the migration', due: 'now', blocks: ['reviewing'] }),
      ],
    });
    const p = holdsRules(g);
    expect(p.status?.text).toBe('do');
    expect(p.status?.tip).toContain('Grant the role (+1 more)');
  });

  it('a due decision reads decide, never its title', () => {
    const g = prOpen({
      headChecks: { sha: HEAD, state: 'passed' },
      humanSteps: [
        step({
          id: 'step-3',
          kind: 'decide',
          title: 'Pick the table',
          due: 'now',
          blocks: ['reviewing'],
        }),
      ],
    });
    const p = holdsRules(g);
    expect(p.status?.text).toBe('decide');
    expect(p.status?.tip).toContain('Pick the table');
  });

  it('a stored work step a review finding needs a person for is a Do block, not a problem notice', () => {
    const g = prOpen({
      headChecks: { sha: HEAD, state: 'passed' },
      humanSteps: [
        step({
          id: 'step-9',
          kind: 'action',
          title: 'Add the missing secret to the environment',
          due: 'now',
          blocks: ['reviewing'],
        }),
      ],
    });
    const p = holdsRules(g);
    expect(p.blocks).toContainEqual({ kind: 'do', id: 'step-9' });
    expect(p.notice).toBeNull();
  });
});

describe('questions and decisions', () => {
  it('an open question is an Answer block and the status says question', () => {
    const g = view({
      status: 'planning',
      list: 'planning',
      type: 'sub',
      questions: [
        {
          id: 'q1',
          text: 'Which table?',
          raisedBy: { kind: 'agent', actor: null },
          source: 'plan_save',
          blocking: 'start',
          raisedAt: NOW,
        },
      ] as PresentableGlob['questions'],
      allowedActions: ['start'],
    });
    const p = holdsRules(g);
    expect(p.status).toMatchObject({ kind: 'question', text: 'question', icon: 'human' });
    expect(p.blocks).toEqual([{ kind: 'answer', id: 'q1' }]);
    // The question holds the start: no Start on the card.
    expect(p.cardPrimary).toBeNull();
  });
});

describe('the card in Planning', () => {
  const planning = (patch: Partial<PresentableGlob> = {}) =>
    view({ status: 'planning', list: 'planning', pr: null, ...patch });

  it('a sub that can start leads with Start', () => {
    const p = holdsRules(planning({ type: 'sub', allowedActions: ['start', 'pick_up'] }));
    expect(p.cardPrimary).toMatchObject({ kind: 'start', label: 'Start' });
  });

  it('a same shows one button, Start, not Start and Pick up', () => {
    const p = holdsRules(planning({ type: 'same', allowedActions: ['start', 'pick_up'] }));
    expect(p.cardPrimary?.kind).toBe('start');
  });

  it('a super in Planning shows Pick up', () => {
    const p = holdsRules(planning({ type: 'super', allowedActions: ['pick_up'] }));
    expect(p.cardPrimary).toMatchObject({ kind: 'pick_up', label: 'Pick up' });
  });

  it('Retry is never on the card', () => {
    const p = holdsRules(
      planning({ type: 'sub', status: 'planning', allowedActions: ['retrigger'] }),
    );
    expect(p.cardPrimary).toBeNull();
  });

  it('a glob that is still being given its branch has no button', () => {
    const p = holdsRules(
      planning({ type: 'sub', provisioning: 'pending', allowedActions: ['start'] }),
    );
    expect(p.cardPrimary).toBeNull();
  });
});

describe('a prepared action', () => {
  const action = (
    actionState: PresentableGlob['actionState'],
    patch: Partial<PresentableGlob> = {},
  ) =>
    view({
      category: 'action',
      type: null,
      status: 'planning',
      list: 'planning',
      pr: null,
      preparation: { record: 'script', rounds: 1 },
      actionState,
      allowedActions: ['complete_action', 'fail_action', 'dismiss_action'],
      ...patch,
    } as Partial<PresentableGlob>);

  it("ready to run is a status for the person, with no card button (Done and Failed… are the glob view's)", () => {
    const p = holdsRules(action('ready'));
    expect(p.status).toMatchObject({ text: 'ready to run', icon: 'human' });
    expect(p.cardPrimary).toBeNull();
  });

  it('preparing and recording are statuses too', () => {
    expect(holdsRules(action('preparing', { allowedActions: [] })).status).toMatchObject({
      text: 'preparing',
      icon: 'machine-spinning',
    });
    expect(
      holdsRules(
        action('preparation_failed', {
          allowedActions: ['prepare_action'],
          failure: { reason: 'The run failed', at: NOW },
        }),
      ).cardPrimary,
    ).toBeNull();
  });
});

describe('the activity log', () => {
  const prLine = (g: PresentableGlob) =>
    present(g).activity.find((e) => e.id.startsWith('pr:7'))?.text;

  it('says the PR is ready for review only when nothing is wrong with it', () => {
    expect(prLine(prOpen())).toBe('PR #7 ready for review · s1t1');
  });

  it('says it conflicts with the base while a conflict is open', () => {
    expect(prLine(prOpen({ conflict }))).toBe('PR #7 conflicts with main · s1t1');
  });

  it('says its checks failed while the head has failed checks', () => {
    expect(prLine(prOpen({ headChecks: failedChecks }))).toBe('PR #7 checks failed · s1t1');
  });

  it('puts the PR line where it happened, not on top', () => {
    const r = run({
      state: 'ended',
      outcome: 'completed',
      startedAt: ago(90 * MINUTE),
      endedAt: ago(80 * MINUTE),
    });
    const g = prOpen({ runs: [r], updatedAt: NOW });
    const feed = present(g).activity;
    expect(feed[0]?.id.startsWith('pr:')).toBe(false);
  });
});

describe('the status is never an action', () => {
  it('holds over a spread of states', () => {
    const states: PresentableGlob[] = [
      prOpen({ allowedActions: ['merge'] }),
      prOpen({ conflict, allowedActions: ['resolve_conflict'] }),
      prOpen({ headChecks: failedChecks }),
      view({
        status: 'planning',
        list: 'planning',
        type: 'super',
        pr: null,
        allowedActions: ['pick_up'],
      }),
      view({
        status: 'signed_off',
        list: 'signed_off',
        pr: { number: 7, state: 'merged', headSha: HEAD },
      }),
    ];
    for (const g of states) {
      const p = holdsRules(g);
      expect(p.status === null || typeof p.status.text === 'string').toBe(true);
    }
  });
});
