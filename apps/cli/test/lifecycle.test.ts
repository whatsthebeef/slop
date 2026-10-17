import { describe, expect, it } from 'vitest';
import type { ToolArguments } from '../src/client.js';
import { SlopError, UsageError } from '../src/errors.js';
import {
  answerCommand,
  finaliseCommand,
  startCommand,
  statusCommand,
  stepCommand,
  workCommand,
  type LifecycleDeps,
} from '../src/lifecycle.js';
import type { Runner } from '../src/process.js';
import { FakeGit } from './support.js';

type Handler = (args: ToolArguments) => unknown;

class FakeSlop {
  readonly calls: Array<{ tool: string; args: ToolArguments }> = [];
  constructor(private readonly handlers: Readonly<Record<string, Handler>>) {}
  call(tool: string, args: ToolArguments = {}): Promise<unknown> {
    this.calls.push({ tool, args });
    const handler = this.handlers[tool];
    if (handler === undefined) return Promise.reject(new SlopError(`unexpected call to ${tool}`));
    return Promise.resolve(handler(args));
  }
}

const view = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1t4',
  title: 'Fix login timeout',
  type: 'same',
  category: 'task',
  status: 'in_progress',
  version: 3,
  branch: 's1t4',
  implementer: 'me@example.com',
  provisioning: 'ok',
  pr: null,
  currentRun: null,
  ...patch,
});

function setup(
  handlers: Record<string, Handler>,
  options: { conversation?: boolean; files?: Record<string, string>; exit?: number } = {},
) {
  const slop = new FakeSlop({ whoami: () => ({ email: 'me@example.com' }), ...handlers });
  const git = new FakeGit();
  git.branch = 's1t4';
  git.remoteBranches.add('s1t4');
  const out: string[] = [];
  const logs: string[] = [];
  const launched: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const inits: Array<{ dir: string; board: string }> = [];
  const runner: Runner = {
    run: (command, args, cwd) => {
      launched.push({ command, args, cwd });
      return Promise.resolve(options.exit ?? 0);
    },
  };
  const deps: LifecycleDeps = {
    client: slop,
    git,
    root: '/repo',
    settings: { SLOP_URL: 'https://slop.test' },
    stdout: (t) => out.push(t),
    log: (m) => logs.push(m),
    now: () => 0,
    sleep: () => Promise.resolve(),
    newIdempotencyKey: () => 'req-1',
    runner,
    whoami: () => Promise.resolve('me@example.com'),
    hasLocalConversation: () => Promise.resolve(options.conversation ?? false),
    initCheckout: (dir, board) => {
      inits.push({ dir, board });
      return Promise.resolve();
    },
    readText: (path) => Promise.resolve(options.files?.[path]),
  };
  return { deps, slop, git, out, logs, launched, inits };
}

const routineRun = {
  id: 'r1',
  state: 'active',
  routineOwner: 'me@example.com',
  sessionUrl: 'https://claude.ai/code/session_01ABC',
};

describe('slop work', () => {
  const handlers = (run: unknown = null) => ({
    get_glob: () => view({ currentRun: run }),
    pick_up: () => view({ currentRun: run }),
  });

  it('sets up the checkout and launches nothing without --agent', async () => {
    const t = setup(handlers());
    await workCommand(['s1t4'], t.deps);
    expect(t.git.ops).toEqual(['fetch', 'checkout s1t4']);
    expect(t.inits).toEqual([{ dir: '/repo', board: '1' }]);
    expect(t.launched).toEqual([]);
    expect(t.out.join('')).toBe('/repo\n');
    expect(t.logs.join('\n')).toContain('slop finalise s1t4');
  });

  it('adds a worktree with --worktree', async () => {
    const t = setup(handlers());
    await workCommand(['s1t4', '--worktree', '/wt/s1t4'], t.deps);
    expect(t.git.ops).toEqual(['fetch', 'worktree /wt/s1t4 s1t4']);
    expect(t.inits).toEqual([{ dir: '/wt/s1t4', board: '1' }]);
  });

  it('refuses a dirty tree when it would switch branches here', async () => {
    const t = setup(handlers());
    t.git.dirty = true;
    await expect(workCommand(['s1t4'], t.deps)).rejects.toThrow(/uncommitted/);
    expect(t.slop.calls).toEqual([]);
  });

  it('--agent teleports an owned routine session with no local conversation', async () => {
    const t = setup(handlers(routineRun), { conversation: false });
    await workCommand(['s1t4', '--agent', '--take-over'], t.deps);
    expect(t.launched).toHaveLength(1);
    expect(t.launched[0]).toMatchObject({ command: 'claude', cwd: '/repo' });
    expect(t.launched[0]?.args.slice(0, 2)).toEqual(['--teleport', 'session_01ABC']);
  });

  it('--agent runs /run-glob with a local conversation, another owner or --no-teleport', async () => {
    for (const [run, conversation, flag] of [
      [routineRun, true, undefined],
      [{ ...routineRun, routineOwner: 'x@example.com' }, false, undefined],
      [routineRun, false, '--no-teleport'],
      [null, false, undefined],
    ] as const) {
      const t = setup(handlers(run), { conversation });
      await workCommand(
        ['s1t4', '--agent', '--take-over', ...(flag === undefined ? [] : [flag])],
        t.deps,
      );
      expect(t.launched).toEqual([{ command: 'claude', args: ['/run-glob s1t4'], cwd: '/repo' }]);
    }
  });

  it('--teleport without a cloud session fails after setup, launching nothing', async () => {
    const t = setup(handlers(null));
    await expect(workCommand(['s1t4', '--agent', '--teleport'], t.deps)).rejects.toThrow(
      /cannot teleport/,
    );
    expect(t.launched).toEqual([]);
  });

  it('checks out the base branch for a merged glob with rollout steps', async () => {
    const t = setup({
      get_glob: () => view({ status: 'reviewing' }),
      pick_up: () => view({ status: 'reviewing' }),
      get_board: () => ({ baseBranch: 'main' }),
    });
    await workCommand(['s1t4'], t.deps);
    expect(t.git.ops).toEqual(['fetch', 'checkout main']);
    expect(t.slop.calls.find((c) => c.tool === 'get_board')?.args).toEqual({ board: 1 });
  });

  it('refuses a base branch or session id that starts with a dash', async () => {
    const base = setup({
      get_glob: () => view({ status: 'reviewing' }),
      pick_up: () => view({ status: 'reviewing' }),
      get_board: () => ({ baseBranch: '--force' }),
    });
    await expect(workCommand(['s1t4'], base.deps)).rejects.toThrow(/base branch/);
    expect(base.git.ops).toEqual(['fetch']);
    const run = { ...routineRun, sessionUrl: '--bad' };
    const t = setup(handlers(run));
    await expect(workCommand(['s1t4', '--agent', '--take-over'], t.deps)).rejects.toThrow(
      /session id/,
    );
    expect(t.launched).toEqual([]);
  });

  it('rejects --teleport without --agent', async () => {
    await expect(
      workCommand(['s1t4', '--teleport'], setup(handlers()).deps),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

const rich = () =>
  view({
    list: 'doing',
    pr: { number: 9, state: 'draft' },
    questions: [
      { id: 'q1', text: 'Which store?', options: ['A', 'B'], blocking: 'start' },
      { id: 'q2', text: 'Old one', answer: { text: 'x' } },
    ],
    humanSteps: [
      { id: 'st1', title: 'Merge', state: 'pending' },
      {
        id: 'st2',
        title: 'Roll out the stack',
        state: 'due',
        commands: ['make rollout'],
        why: 'new table',
      },
    ],
    failedChecks: {
      text: 'Tests failed',
      lines: ['FAIL a.test.ts'],
      url: 'https://ci/1',
      inherited: false,
    },
    artifacts: [{ kind: 'implementation_plan', commitSha: 'abc1234' }],
  });

describe('slop status', () => {
  it('lists open questions with options, due steps with commands, failed checks and the next step', async () => {
    const t = setup({ get_glob: rich });
    await statusCommand(['s1t4'], t.deps);
    const text = t.out.join('');
    expect(text).toContain('q1: Which store?');
    expect(text).toContain('    - A');
    expect(text).not.toContain('Old one');
    expect(text).toContain('2. Roll out the stack (st2)');
    expect(text).toContain('$ make rollout');
    expect(text).toContain('FAIL a.test.ts');
    expect(text).toContain('https://ci/1');
    expect(text).toContain('PR: #9 draft');
    expect(text).toContain('Next: answer q1');
  });

  it('suggests finalise, then ready, and prints JSON with --json', async () => {
    const t = setup({ get_glob: () => view({ artifacts: [] }) });
    await statusCommand(['--json'], t.deps);
    expect(JSON.parse(t.out.join(''))).toMatchObject({
      id: 's1t4',
      finalised: { record: false, review: false },
    });
    expect((JSON.parse(t.out.join('')) as { next: string }).next).toContain('slop finalise s1t4');
    const done = setup({
      get_glob: () =>
        view({
          artifacts: [
            { kind: 'implementation_plan', commitSha: 'abc1234' },
            { kind: 'local_review', commitSha: 'abc1234' },
          ],
        }),
    });
    await statusCommand([], done.deps);
    expect(done.out.join('')).toContain('Next: slop ready s1t4');
  });
});

describe('slop answer and step', () => {
  it('answers an option with the option, or free text as the answer', async () => {
    const t = setup({ get_glob: rich, answer_question: () => view() });
    await answerCommand(['s1t4', 'q1', 'b'], t.deps);
    await answerCommand(['s1t4', '1', 'use', 'the', 'new', 'one'], t.deps);
    const calls = t.slop.calls.filter((c) => c.tool === 'answer_question');
    expect(calls[0]?.args).toEqual({ id: 's1t4', questionId: 'q1', answer: '', option: 'B' });
    expect(calls[1]?.args).toEqual({ id: 's1t4', questionId: 'q1', answer: 'use the new one' });
    await expect(answerCommand(['s1t4', 'q2', 'x'], t.deps)).rejects.toThrow(
      /no open question 'q2' \(open: q1\)/,
    );
  });

  it('completes, fails and dismisses a step by number or id', async () => {
    const t = setup({
      get_glob: rich,
      complete_human_step: () => ({}),
      fail_human_step: () => ({}),
      dismiss_human_step: () => ({}),
    });
    await stepCommand(['s1t4', '2', 'done', '--note', 'ran by hand'], t.deps);
    await stepCommand(['s1t4', 'st2', 'failed', 'boom', 'at', 'line 3'], t.deps);
    await stepCommand(['s1t4', '1', 'dismiss', 'not needed'], t.deps);
    const calls = t.slop.calls.filter((c) => c.tool.endsWith('human_step'));
    expect(calls.map((c) => [c.tool, c.args])).toEqual([
      ['complete_human_step', { id: 's1t4', stepId: 'st2', version: 3, note: 'ran by hand' }],
      ['fail_human_step', { id: 's1t4', stepId: 'st2', version: 3, note: 'boom at line 3' }],
      ['dismiss_human_step', { id: 's1t4', stepId: 'st1', version: 3, reason: 'not needed' }],
    ]);
  });

  it('needs the output or reason, and a known step', async () => {
    const t = setup({ get_glob: rich });
    await expect(stepCommand(['s1t4', '2', 'failed'], t.deps)).rejects.toBeInstanceOf(UsageError);
    await expect(stepCommand(['s1t4', '9', 'done'], t.deps)).rejects.toThrow(/no step '9'/);
  });
});

describe('slop start', () => {
  it('calls start_glob with the version read', async () => {
    const t = setup({
      get_glob: () => view({ status: 'planning' }),
      start_glob: () => view({ status: 'implementing' }),
    });
    await startCommand(['s1t4', '--anyway', '--reason', 'urgent'], t.deps);
    expect(t.slop.calls.at(-1)).toEqual({
      tool: 'start_glob',
      args: { id: 's1t4', version: 3, anyway: true, reason: 'urgent' },
    });
    expect(t.out.join('')).toBe('s1t4: implementing\n');
  });
});

describe('slop finalise', () => {
  const marker = { '/repo/.sstor/.finalised': 'req-1\nabc1234\n' };
  const glob = () =>
    view({
      artifacts: [
        { kind: 'implementation_plan', commitSha: 'abc1234' },
        { kind: 'local_review', commitSha: 'abc1234' },
      ],
    });

  it('passes the note and learnings mode; facts is the default when no agent worked here', async () => {
    const t = setup({ get_glob: glob }, { files: marker });
    await finaliseCommand(['--note', 'a "quoted" why'], t.deps);
    expect(t.launched).toEqual([
      {
        command: 'claude',
        args: ['-p', '/finalise req-1 --learnings facts --note "a \\"quoted\\" why"'],
        cwd: '/repo',
      },
    ]);
    expect(t.out.join('')).toContain('implementation record: yes, local review: yes');
  });

  it('uses the head after the run (a super merges the base) for the marker and the artifacts', async () => {
    const t = setup(
      {
        get_glob: () =>
          view({
            artifacts: [
              { kind: 'implementation_plan', commitSha: 'new5678' },
              { kind: 'local_review', commitSha: 'new5678' },
            ],
          }),
      },
      { files: { '/repo/.sstor/.finalised': 'req-1\nnew5678\n' } },
    );
    const moving: Runner = {
      run: () => {
        t.git.sha = 'new5678';
        return Promise.resolve(0);
      },
    };
    const deps = { ...t.deps, runner: moving };
    await finaliseCommand([], deps);
    expect(t.out.join('')).toContain('finalised at new5678');
    expect(t.out.join('')).toContain('implementation record: yes, local review: yes');
  });

  it('defaults to all after a local conversation, and takes an explicit mode', async () => {
    const t = setup({ get_glob: glob }, { files: marker, conversation: true });
    await finaliseCommand([], t.deps);
    expect(t.launched[0]?.args[1]).toBe('/finalise req-1 --learnings all');
    const none = setup({ get_glob: glob }, { files: marker, conversation: true });
    await finaliseCommand(['s1t4', '--learnings', 'none'], none.deps);
    expect(none.launched[0]?.args[1]).toBe('/finalise req-1 --learnings none');
    await expect(finaliseCommand(['--learnings', 'some'], none.deps)).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it('fails without the completion marker, or on a dirty tree or a claude failure', async () => {
    await expect(finaliseCommand([], setup({ get_glob: glob }).deps)).rejects.toThrow(
      /did not finish/,
    );
    const dirty = setup({ get_glob: glob }, { files: marker });
    dirty.git.dirty = true;
    await expect(finaliseCommand([], dirty.deps)).rejects.toThrow(/uncommitted/);
    expect(dirty.launched).toEqual([]);
    await expect(
      finaliseCommand([], setup({ get_glob: glob }, { files: marker, exit: 3 }).deps),
    ).rejects.toThrow(/exited with code 3/);
  });
});
