import { describe, expect, it } from 'vitest';
import { SlopError, UsageError } from '../src/errors.js';
import {
  PROVISION_TIMEOUT_MS,
  globCommand,
  mergeCommand,
  newCommand,
  pickUpCommand,
  readyCommand,
  type GlobDeps,
} from '../src/globs.js';
import type { ToolArguments } from '../src/client.js';
import { FakeGit } from './support.js';

const ROOT = '/repo';

interface Call {
  readonly tool: string;
  readonly args: ToolArguments;
}

type Handler = (args: ToolArguments) => unknown;

/** slop's MCP tools in memory: each tool answers through its handler; every call is recorded. */
class FakeSlop {
  readonly calls: Call[] = [];
  constructor(private readonly handlers: Readonly<Record<string, Handler>>) {}

  call(tool: string, args: ToolArguments = {}): Promise<unknown> {
    this.calls.push({ tool, args });
    const handler = this.handlers[tool];
    if (handler === undefined) return Promise.reject(new SlopError(`unexpected call to ${tool}`));
    try {
      return Promise.resolve(handler(args));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  tools(): string[] {
    return this.calls.map((c) => c.tool);
  }
}

interface GlobFields {
  id: string;
  title: string;
  type: string;
  category: string;
  status: string;
  version: number;
  branch: string;
  implementer: string | null;
  provisioning: string;
  pr: { number: number; state: string } | null;
  currentRun: {
    id: string;
    state: string;
    routineOwner?: string;
    sessionUrl?: string | null;
  } | null;
}

function glob(patch: Partial<GlobFields> = {}): GlobFields {
  return {
    id: 's1t4',
    title: 'Fix login timeout',
    type: 'same',
    category: 'task',
    status: 'planning',
    version: 3,
    branch: 's1t4',
    implementer: null,
    provisioning: 'none',
    pr: null,
    currentRun: null,
    ...patch,
  };
}

function setup(
  handlers: Readonly<Record<string, Handler>>,
  options: { root?: string | undefined; board?: string } = {},
): {
  deps: GlobDeps;
  slop: FakeSlop;
  git: FakeGit;
  out: string[];
  logs: string[];
  sleeps: number[];
} {
  const slop = new FakeSlop(handlers);
  const git = new FakeGit();
  const out: string[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const deps: GlobDeps = {
    client: slop,
    git,
    root: 'root' in options ? options.root : ROOT,
    settings: options.board === undefined ? {} : { SLOP_BOARD: options.board },
    stdout: (text) => out.push(text),
    log: (message) => logs.push(message),
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    newIdempotencyKey: () => 'key-1',
  };
  return { deps, slop, git, out, logs, sleeps };
}

describe('slop glob', () => {
  it('prints the summary, or JSON with --json', async () => {
    const view = glob({
      status: 'in_progress',
      implementer: 'ann@x.test',
      pr: { number: 9, state: 'draft' },
    });
    const human = setup({ get_glob: () => ({ ...view, labels: {} }) });
    await globCommand(['s1t4'], human.deps);
    expect(human.out.join('')).toBe(
      's1t4 [same task] in_progress: Fix login timeout (branch s1t4; implementer ann@x.test; run none; PR #9 draft)\n',
    );
    const json = setup({ get_glob: () => view });
    await globCommand(['s1t4', '--json'], json.deps);
    expect(JSON.parse(json.out.join(''))).toEqual({ ...view, environment: null });
  });

  it("includes the glob's environment when it has one", async () => {
    const view = { ...glob({ status: 'in_progress' }), environment: 'dev' };
    const human = setup({ get_glob: () => view });
    await globCommand(['s1t4'], human.deps);
    expect(human.out.join('')).toContain('(branch s1t4; environment dev; implementer none;');
    const json = setup({ get_glob: () => view });
    await globCommand(['s1t4', '--json'], json.deps);
    expect(JSON.parse(json.out.join(''))).toMatchObject({ environment: 'dev' });
  });

  it('refuses a missing or malformed ID', async () => {
    const { deps } = setup({});
    await expect(globCommand([], deps)).rejects.toBeInstanceOf(UsageError);
    await expect(globCommand(['--branch'], deps)).rejects.toBeInstanceOf(UsageError);
    await expect(globCommand(['main'], deps)).rejects.toBeInstanceOf(UsageError);
  });
});

describe('slop pick-up', () => {
  it('picks up, waits for provisioning and the branch, and prints it', async () => {
    let reads = 0;
    const run = setup({
      get_glob: () => {
        reads += 1;
        return reads === 1
          ? glob()
          : glob({
              status: 'in_progress',
              version: 5,
              provisioning: reads >= 3 ? 'ok' : 'pending',
            });
      },
      pick_up: () =>
        glob({
          status: 'in_progress',
          version: 4,
          implementer: 'ann@x.test',
          provisioning: 'pending',
        }),
    });
    run.git.remoteBranches.add('s1t4');
    await pickUpCommand(['s1t4'], run.deps);
    expect(run.slop.calls[1]).toEqual({ tool: 'pick_up', args: { id: 's1t4', version: 3 } });
    expect(run.slop.tools()).toEqual(['get_glob', 'pick_up', 'get_glob', 'get_glob']);
    expect(run.sleeps).toEqual([1_000, 2_000]);
    expect(run.out).toEqual(['s1t4\n']);
  });

  it('refuses a queued run without --take-over (sstor only checked active and watching)', async () => {
    const run = setup({
      get_glob: () =>
        glob({
          status: 'implementing',
          currentRun: { id: 'r1', state: 'queued', routineOwner: 'bob@x.test' },
        }),
    });
    await expect(pickUpCommand(['s1t4'], run.deps)).rejects.toThrow(
      /run queued \(owner bob@x.test\).*--take-over/,
    );
    expect(run.slop.tools()).toEqual(['get_glob']);
  });

  it('takes over a live run with --take-over', async () => {
    const run = setup({
      get_glob: () => glob({ status: 'implementing', currentRun: { id: 'r1', state: 'watching' } }),
      pick_up: () => glob({ status: 'in_progress', provisioning: 'ok' }),
    });
    run.git.remoteBranches.add('s1t4');
    await pickUpCommand(['s1t4', '--take-over'], run.deps);
    expect(run.slop.calls[1]?.args).toEqual({ id: 's1t4', version: 3, takeOver: true });
  });

  it('passes --env to pick_up, as --env <name> or --env=<name>', async () => {
    for (const args of [
      ['s1t4', '--env', 'dev'],
      ['--env=dev', 's1t4'],
    ]) {
      const run = setup({
        get_glob: () => glob({ status: 'failed', provisioning: 'ok' }),
        pick_up: () => glob({ status: 'in_progress', provisioning: 'ok' }),
      });
      run.git.remoteBranches.add('s1t4');
      await pickUpCommand(args, run.deps);
      expect(run.slop.calls[1]?.args).toEqual({ id: 's1t4', version: 3, environment: 'dev' });
    }
    const { deps } = setup({});
    await expect(pickUpCommand(['s1t4', '--env'], deps)).rejects.toBeInstanceOf(UsageError);
    await expect(pickUpCommand(['s1t4', '--env', '--json'], deps)).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it('does not ask for a take-over when there is no run to take over', async () => {
    const run = setup({
      get_glob: () => glob({ status: 'failed', provisioning: 'ok' }),
      pick_up: () => glob({ status: 'in_progress', provisioning: 'ok' }),
    });
    run.git.remoteBranches.add('s1t4');
    await pickUpCommand(['s1t4', '--take-over'], run.deps);
    expect(run.slop.calls[1]?.args).toEqual({ id: 's1t4', version: 3 });
  });

  it('re-picks your own glob, so your failed glob goes back to in_progress', async () => {
    const run = setup({
      get_glob: () => glob({ status: 'failed', implementer: 'ann@x.test', provisioning: 'ok' }),
      pick_up: () =>
        glob({ status: 'in_progress', implementer: 'ann@x.test', provisioning: 'ok', version: 4 }),
    });
    run.git.remoteBranches.add('s1t4');
    await pickUpCommand(['s1t4', '--json'], run.deps);
    expect(run.slop.tools()).toEqual(['get_glob', 'pick_up']);
    expect(JSON.parse(run.out.join(''))).toMatchObject({ status: 'in_progress', branch: 's1t4' });
  });

  it('refuses a merged glob', async () => {
    const run = setup({ get_glob: () => glob({ status: 'reviewing' }) });
    await expect(pickUpCommand(['s1t4'], run.deps)).rejects.toThrow(/already merged/);
  });

  it('gives up after the provisioning timeout', async () => {
    const run = setup({
      get_glob: () => glob({ status: 'in_progress', provisioning: 'pending' }),
      pick_up: () => glob({ status: 'in_progress', provisioning: 'pending' }),
    });
    await expect(pickUpCommand(['s1t4'], run.deps)).rejects.toThrow(
      /no branch yet \(provisioning: pending\)/,
    );
    expect(run.sleeps.reduce((a, b) => a + b, 0)).toBe(PROVISION_TIMEOUT_MS);
    expect(Math.max(...run.sleeps)).toBe(8_000);
  });

  it('waits for origin to have the branch after provisioning is ok', async () => {
    const run = setup({
      get_glob: () => glob({ status: 'in_progress', provisioning: 'ok' }),
      pick_up: () => glob({ status: 'in_progress', provisioning: 'ok' }),
    });
    await expect(pickUpCommand(['s1t4'], run.deps)).rejects.toThrow(/no branch yet/);
    expect(run.git.remoteChecks).toBeGreaterThan(1);
  });

  it('refuses a branch from slop that is not the glob ID, before any git call', async () => {
    for (const branch of ['--upload-pack=touch /tmp/pwned', 'x/s1t4', 's1t5']) {
      const run = setup({
        get_glob: () => glob(),
        pick_up: () => glob({ status: 'in_progress', provisioning: 'ok', branch }),
      });
      await expect(pickUpCommand(['s1t4'], run.deps)).rejects.toThrow(/returned branch/);
      expect(run.git.remoteChecks).toBe(0);
      expect(run.out).toEqual([]);
    }
    const shown = setup({ get_glob: () => glob({ branch: '-x' }) });
    await expect(globCommand(['s1t4'], shown.deps)).rejects.toThrow(/returned branch '-x'/);
  });

  it('treats a failed remote check as not yet until the deadline', async () => {
    const run = setup({
      get_glob: () => glob({ status: 'in_progress', provisioning: 'ok' }),
      pick_up: () => glob({ status: 'in_progress', provisioning: 'ok' }),
    });
    run.git.remoteBranches.add('s1t4');
    run.git.failingRemoteChecks = 2;
    await pickUpCommand(['s1t4'], run.deps);
    expect(run.git.remoteChecks).toBe(3);
    expect(run.out).toEqual(['s1t4\n']);

    const down = setup({
      get_glob: () => glob({ status: 'in_progress', provisioning: 'ok' }),
      pick_up: () => glob({ status: 'in_progress', provisioning: 'ok' }),
    });
    down.git.failingRemoteChecks = 1_000;
    await expect(pickUpCommand(['s1t4'], down.deps)).rejects.toThrow(
      /no branch yet.*last git error: could not read from remote repository/,
    );
  });

  it('fails at once when provisioning failed', async () => {
    const run = setup({
      get_glob: () => glob(),
      pick_up: () => glob({ status: 'in_progress', provisioning: 'failed' }),
    });
    await expect(pickUpCommand(['s1t4'], run.deps)).rejects.toThrow(/could not create its branch/);
    expect(run.sleeps).toEqual([]);
  });
});

describe('slop new', () => {
  const created = (patch: Record<string, unknown> = {}) => ({
    id: 's1t9',
    version: 1,
    branch: 's1t9',
    provisioning: 'none',
    status: 'planning',
    type: 'same',
    category: 'task',
    group: null,
    environment: null,
    summary: '',
    ...patch,
  });

  it('creates through intake with the prompt and a fresh idempotency key', async () => {
    const run = setup({ create_glob: () => created() }, { board: '1' });
    await newCommand(['fix', 'the', 'login', 'timeout'], run.deps);
    expect(run.slop.calls).toEqual([
      {
        tool: 'create_glob',
        args: { board: 1, idempotencyKey: 'key-1', input: 'fix the login timeout' },
      },
    ]);
    expect(run.out).toEqual([
      's1t9 [same task] planning: branch s1t9; pick it up to implement it\n',
    ]);
  });

  it('passes --after (repeatable, or a comma list) and says the glob waits', async () => {
    const run = setup(
      { create_glob: () => created({ type: 'sub', after: ['s1t7', 's1t8'], waiting: true }) },
      { board: '1' },
    );
    await newCommand(['--sub', '--after', 's1t7,s1t8', '--after=s1t6', 'add', 'a', 'column'], run.deps);
    expect(run.slop.calls[0]?.args).toMatchObject({ type: 'sub', after: ['s1t7', 's1t8', 's1t6'] });
    expect(run.out.join('')).toContain('waiting for s1t7, s1t8 to merge');
    await expect(newCommand(['--after', 'oops', 'x'], run.deps)).rejects.toBeInstanceOf(UsageError);
  });

  it('maps type, category and --routine to create_glob arguments', async () => {
    const run = setup({ create_glob: () => created({ status: 'implementing' }) }, { board: '2' });
    await newCommand(['--same', '--bug', '--routine', '--json', 'crash on save'], run.deps);
    expect(run.slop.calls[0]?.args).toEqual({
      board: 2,
      idempotencyKey: 'key-1',
      input: 'crash on save',
      type: 'same',
      category: 'bug',
      autoTrigger: true,
    });
    expect(JSON.parse(run.out.join(''))).toMatchObject({ id: 's1t9', routine: true });

    const sub = setup(
      { create_glob: () => created({ type: 'sub', status: 'implementing' }) },
      { board: '2' },
    );
    await newCommand(['--sub', '--feature', 'add a tooltip'], sub.deps);
    expect(sub.slop.calls[0]?.args).toMatchObject({ type: 'sub', category: 'feature' });
    expect(sub.slop.calls[0]?.args).not.toHaveProperty('autoTrigger');
    expect(sub.out.join('')).toContain('a routine will implement it');

    const sup = setup({ create_glob: () => created({ type: 'super' }) }, { board: '2' });
    await newCommand(['--super', 'pairing'], sup.deps);
    expect(sup.slop.calls[0]?.args).toMatchObject({ type: 'super' });
  });

  it('passes --env to create_glob', async () => {
    const run = setup({ create_glob: () => created({ type: 'super' }) }, { board: '2' });
    await newCommand(['--super', '--env', 'dev', 'pair', 'on', 'export'], run.deps);
    expect(run.slop.calls[0]?.args).toEqual({
      board: 2,
      idempotencyKey: 'key-1',
      input: 'pair on export',
      type: 'super',
      environment: 'dev',
    });
  });

  it('refuses bad flag combinations, no prompt and no board', async () => {
    const { deps, slop } = setup({ create_glob: () => created() }, { board: '1' });
    await expect(newCommand(['--same', '--sub', 'x'], deps)).rejects.toBeInstanceOf(UsageError);
    await expect(newCommand(['--task', '--bug', 'x'], deps)).rejects.toBeInstanceOf(UsageError);
    await expect(newCommand(['--super', '--routine', 'x'], deps)).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(newCommand(['--fast', 'x'], deps)).rejects.toBeInstanceOf(UsageError);
    await expect(newCommand(['--same'], deps)).rejects.toBeInstanceOf(UsageError);
    const noBoard = setup({ create_glob: () => created() });
    await expect(newCommand(['x'], noBoard.deps)).rejects.toThrow(/SLOP_BOARD/);
    expect(slop.calls).toEqual([]);
  });
});

describe('slop ready', () => {
  it('pushes the current branch and marks the PR ready', async () => {
    const run = setup({
      get_glob: () => glob({ status: 'in_progress', pr: { number: 9, state: 'draft' } }),
      mark_ready: () => ({
        id: 's1t4',
        status: 'in_progress',
        pr: { number: 9, state: 'draft' },
        note: '',
      }),
    });
    run.git.branch = 's1t4';
    await readyCommand([], run.deps);
    expect(run.git.pushes).toEqual(['s1t4']);
    expect(run.slop.calls.at(-1)).toEqual({ tool: 'mark_ready', args: { id: 's1t4' } });
    expect(run.out.join('')).toContain('pushed and marked ready');
  });

  it('treats a glob already pr_open with a ready PR as done (sstor failed there)', async () => {
    const run = setup({
      get_glob: () => glob({ status: 'pr_open', pr: { number: 9, state: 'ready' } }),
    });
    run.git.branch = 's1t4';
    await readyCommand(['s1t4', '--json'], run.deps);
    expect(run.git.pushes).toEqual(['s1t4']);
    expect(run.slop.tools()).toEqual(['get_glob']);
    expect(JSON.parse(run.out.join(''))).toMatchObject({
      id: 's1t4',
      status: 'pr_open',
      alreadyReady: true,
    });
  });

  it('refuses a dirty working tree before talking to slop or pushing', async () => {
    const run = setup({ get_glob: () => glob() });
    run.git.branch = 's1t4';
    run.git.dirty = true;
    await expect(readyCommand([], run.deps)).rejects.toThrow(/uncommitted changes/);
    expect(run.git.pushes).toEqual([]);
    expect(run.slop.calls).toEqual([]);
  });

  it('refuses outside a checkout, off a glob branch, and for a merged glob', async () => {
    await expect(readyCommand(['s1t4'], setup({}, { root: undefined }).deps)).rejects.toThrow(
      /git checkout/,
    );
    const main = setup({});
    main.git.branch = 'main';
    await expect(readyCommand([], main.deps)).rejects.toBeInstanceOf(UsageError);
    const merged = setup({ get_glob: () => glob({ status: 'reviewing' }) });
    merged.git.branch = 's1t4';
    await expect(readyCommand(['s1t4'], merged.deps)).rejects.toThrow(/already merged/);
    expect(merged.git.pushes).toEqual([]);
  });

  it('refuses an explicit ID that is not the checked-out branch', async () => {
    const run = setup({ get_glob: () => glob() });
    run.git.branch = 's1t5';
    await expect(readyCommand(['s1t4'], run.deps)).rejects.toThrow(
      /not the checked-out branch \(s1t5\)/,
    );
    expect(run.git.pushes).toEqual([]);
    expect(run.slop.calls).toEqual([]);
  });

  it('warns about untracked files other than the ones sstor and the agents leave', async () => {
    const run = setup({
      get_glob: () => glob({ status: 'pr_open', pr: { number: 9, state: 'ready' } }),
    });
    run.git.branch = 's1t4';
    run.git.untracked = ['.claude/', 'CLAUDE.md', '.reviews/', 'src/new-module.ts'];
    await readyCommand([], run.deps);
    expect(run.logs.join('\n')).toMatch(/warning: untracked files.*: src\/new-module\.ts$/);
    expect(run.git.pushes).toEqual(['s1t4']);

    const quiet = setup({
      get_glob: () => glob({ status: 'pr_open', pr: { number: 9, state: 'ready' } }),
    });
    quiet.git.branch = 's1t4';
    quiet.git.untracked = ['.claude/', 'CLAUDE.md', '.reviews/'];
    await readyCommand([], quiet.deps);
    expect(quiet.logs).toEqual([]);
  });
});

describe('slop merge', () => {
  it('merges through slop with the version it read and prints the status', async () => {
    const run = setup({
      get_glob: () => glob({ status: 'pr_open', version: 7, pr: { number: 9, state: 'ready' } }),
      merge: () => glob({ status: 'merging', version: 8, pr: { number: 9, state: 'ready' } }),
    });
    run.git.branch = 's1t4';
    await mergeCommand([], run.deps);
    expect(run.slop.calls.at(-1)).toEqual({ tool: 'merge', args: { id: 's1t4', version: 7 } });
    expect(run.out.join('')).toMatch(/^s1t4: merging \(/);
  });

  it('retries once on a version conflict with a fresh read', async () => {
    let reads = 0;
    let merges = 0;
    const run = setup({
      get_glob: () => {
        reads += 1;
        return glob({ status: 'pr_open', version: reads === 1 ? 7 : 9 });
      },
      merge: () => {
        merges += 1;
        if (merges === 1) throw new SlopError('version_conflict: The glob changed');
        return glob({ status: 'merging', version: 10 });
      },
    });
    await mergeCommand(['s1t4'], run.deps);
    expect(run.slop.calls.filter((c) => c.tool === 'merge').map((c) => c.args)).toEqual([
      { id: 's1t4', version: 7 },
      { id: 's1t4', version: 9 },
    ]);
    expect(run.out.join('')).toMatch(/^s1t4: merging/);

    const twice = setup({
      get_glob: () => glob({ status: 'pr_open' }),
      merge: () => {
        throw new SlopError('version_conflict: The glob changed');
      },
    });
    await expect(mergeCommand(['s1t4'], twice.deps)).rejects.toThrow(/version_conflict/);
    expect(twice.slop.tools()).toEqual(['get_glob', 'merge', 'get_glob', 'merge']);
  });

  it('merges and continues a super with --continue', async () => {
    const run = setup({
      get_glob: () => glob({ type: 'super', status: 'pr_open', version: 7, pr: { number: 9, state: 'ready' } }),
      merge: () => glob({ type: 'super', status: 'in_progress', version: 9, pr: null }),
    });
    await mergeCommand(['s1t4', '--continue'], run.deps);
    expect(run.slop.calls.at(-1)).toEqual({ tool: 'merge', args: { id: 's1t4', version: 7, continue: true } });
    expect(run.out.join('')).toMatch(/^s1t4: in_progress \(merged and continued/);
  });

  it('reports an already merged glob without merging again', async () => {
    const run = setup({ get_glob: () => glob({ status: 'reviewing' }) });
    await mergeCommand(['s1t4', '--json'], run.deps);
    expect(run.slop.tools()).toEqual(['get_glob']);
    expect(JSON.parse(run.out.join(''))).toMatchObject({ status: 'reviewing' });
  });

  it("passes slop's refusal through", async () => {
    const run = setup({
      get_glob: () => glob({ status: 'pr_open' }),
      merge: () => {
        throw new SlopError(
          'invalid_transition: Required checks have not passed on the current head',
        );
      },
    });
    await expect(mergeCommand(['s1t4'], run.deps)).rejects.toThrow(/checks have not passed/);
  });
});
