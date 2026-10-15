import type { AtfBatch, AtfIntegration, Effect, Result } from '@slop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ clients: [] as { config: unknown }[], inputs: [] as unknown[] }));

vi.mock('@aws-sdk/client-codebuild', () => ({
  CodeBuildClient: class {
    constructor(readonly config: unknown) {
      calls.clients.push(this);
    }
    send(command: { input: unknown }) {
      calls.inputs.push(command.input);
      return Promise.resolve({ build: { id: 'atf-project:1234' } });
    }
  },
  StartBuildCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

const { startAtf } = await import('../src/atf-executors.js');
const { AtfRefusedError, CodeBuildAtfStarter, atfIdempotencyToken, atfVariables, combineGreps } =
  await import('../src/atf-starter.js');
import type { AtfStart, AtfStarter } from '../src/atf-starter.js';

const integration: AtfIntegration = {
  provider: 'codebuild',
  region: 'eu-west-1',
  project: 'atf-project',
  mode: 'push',
};
const policy = { projects: ['atf-project'], roleAccounts: ['123456789012'] };
const job: AtfStart = {
  boardId: 7,
  integration,
  environment: 'staging',
  sha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
  specs: ['e2e/a.spec.ts', 'e2e/b.spec.ts'],
  greps: ['@smoke', '@rollout'],
};

describe('the CodeBuild ATF starter', () => {
  beforeEach(() => {
    calls.clients.length = 0;
    calls.inputs.length = 0;
  });

  it('starts the project with the spec list in variable overrides and a per-deploy idempotency token', async () => {
    const started = await new CodeBuildAtfStarter(policy).start(job);
    expect(started).toEqual({
      buildId: 'atf-project:1234',
      url: 'https://eu-west-1.console.aws.amazon.com/codesuite/codebuild/projects/atf-project/build/atf-project%3A1234/?region=eu-west-1',
    });
    expect(calls.inputs).toEqual([
      {
        projectName: 'atf-project',
        idempotencyToken: atfIdempotencyToken(7, 'staging', job.sha),
        environmentVariablesOverride: [
          { name: 'SLOP_ATF_SPECS', value: 'e2e/a.spec.ts\ne2e/b.spec.ts', type: 'PLAINTEXT' },
          { name: 'SLOP_ATF_GREP', value: '(?:@smoke)|(?:@rollout)', type: 'PLAINTEXT' },
          { name: 'SLOP_ENVIRONMENT', value: 'staging', type: 'PLAINTEXT' },
          { name: 'SLOP_SHA', value: job.sha, type: 'PLAINTEXT' },
        ],
      },
    ]);
    expect(calls.clients[0]?.config).toEqual({ region: 'eu-west-1' });
  });

  it('gives the same token to the same deploy and a different one to any other', () => {
    expect(atfIdempotencyToken(7, 'staging', job.sha)).toBe(
      atfIdempotencyToken(7, 'staging', job.sha),
    );
    expect(atfIdempotencyToken(7, 'staging', job.sha)).not.toBe(
      atfIdempotencyToken(8, 'staging', job.sha),
    );
    expect(atfIdempotencyToken(7, 'staging', job.sha)).not.toBe(
      atfIdempotencyToken(7, 'prod', job.sha),
    );
    expect(atfIdempotencyToken(7, 'staging', job.sha)).not.toBe(
      atfIdempotencyToken(7, 'staging', 'b'.repeat(40)),
    );
  });

  it('sends empty lists for the default suite, and combines greps', () => {
    expect(atfVariables({ ...job, specs: [], greps: [] })).toMatchObject({
      SLOP_ATF_SPECS: '',
      SLOP_ATF_GREP: '',
    });
    expect(combineGreps(['@a'])).toBe('@a');
    expect(combineGreps(['@a', '@a'])).toBe('@a');
  });

  it('assumes the board’s role first when it names one', async () => {
    const assumed: string[] = [];
    const credentials = {
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      sessionToken: 'ST',
      expiration: new Date('2026-10-05T13:00:00Z'),
    };
    const starter = new CodeBuildAtfStarter(policy, (roleArn, region, externalId) => {
      assumed.push(`${roleArn}@${region}#${externalId}`);
      return Promise.resolve(credentials);
    });
    await starter.start({
      ...job,
      integration: { ...integration, roleArn: 'arn:aws:iam::123456789012:role/slop-atf', externalId: 'ext-7' },
    });
    expect(assumed).toEqual(['arn:aws:iam::123456789012:role/slop-atf@eu-west-1#ext-7']);
    expect(calls.clients[0]?.config).toEqual({ region: 'eu-west-1', credentials });
  });
});

describe('the CodeBuild ATF starter and the server allow-list', () => {
  const withRole = { ...integration, roleArn: 'arn:aws:iam::123456789012:role/slop-atf', externalId: 'ext-7' };
  const assumeNever = () => Promise.reject(new Error('must not assume'));

  beforeEach(() => {
    calls.clients.length = 0;
    calls.inputs.length = 0;
  });

  it('starts nothing without an allow-list, so slop never uses its own credentials for a board-chosen project', async () => {
    await expect(new CodeBuildAtfStarter().start(job)).rejects.toBeInstanceOf(AtfRefusedError);
    expect(calls.clients).toEqual([]);
    expect(calls.inputs).toEqual([]);
  });

  it('refuses a project or a role account outside the allow-list at start time, before any AWS call', async () => {
    const starter = new CodeBuildAtfStarter(policy, assumeNever);
    await expect(starter.start({ ...job, integration: { ...integration, project: 'other-deploy' } })).rejects.toBeInstanceOf(AtfRefusedError);
    await expect(
      starter.start({ ...job, integration: { ...withRole, roleArn: 'arn:aws:iam::999999999999:role/slop-atf' } }),
    ).rejects.toBeInstanceOf(AtfRefusedError);
    expect(calls.clients).toEqual([]);
    expect(calls.inputs).toEqual([]);
  });

  it('refuses to assume a role that has no ExternalId', async () => {
    const noId: AtfIntegration = { ...integration, roleArn: withRole.roleArn };
    await expect(new CodeBuildAtfStarter(policy, assumeNever).start({ ...job, integration: noId })).rejects.toBeInstanceOf(AtfRefusedError);
    expect(calls.inputs).toEqual([]);
  });
});

describe('the start_atf executor', () => {
  const effect: Effect = {
    kind: 'start_atf',
    globId: 'board-7',
    boardId: 7,
    environment: 'staging',
    sha: job.sha,
  };
  const batch: AtfBatch = {
    id: 1,
    boardId: 7,
    environment: 'staging',
    sha: job.sha,
    specs: [{ spec: 'e2e/a.spec.ts', globIds: ['s1t1'] }],
    greps: [{ grep: '@smoke', globIds: ['s1t1'] }],
    createdAt: '2026-10-05T13:00:00.000Z',
  };
  const starts: AtfStart[] = [];
  const starter: AtfStarter = {
    start: (j) => {
      starts.push(j);
      return Promise.resolve({ buildId: 'b1', url: null });
    },
  };
  const run = (
    answer: Result<
      | { status: 'pending' }
      | { status: 'superseded'; latestSha: string }
      | { status: 'ready'; batch: AtfBatch }
    >,
    atf: AtfIntegration | null = integration,
  ) => {
    const logged: string[] = [];
    const deps = {
      testRuns: { atfBatch: () => Promise.resolve(answer) },
      starter,
      boardOf: () => Promise.resolve({ atf }),
      log: (_task: string, message: string) => logged.push(message),
    };
    return { logged, outcome: () => startAtf(effect, deps) };
  };

  beforeEach(() => {
    starts.length = 0;
  });

  it('starts the build with the stored batch, and a repeat starts it again with the same token (CodeBuild dedupes)', async () => {
    const { outcome } = run({ ok: true, value: { status: 'ready', batch } });
    expect(await outcome()).toBe('done');
    expect(await outcome()).toBe('done');
    expect(starts).toHaveLength(2);
    expect(starts[0]).toEqual({ ...job, specs: ['e2e/a.spec.ts'], greps: ['@smoke'] });
  });

  it('drops, and logs, a start the allow-list refuses instead of retrying it', async () => {
    const refusing: AtfStarter = { start: () => Promise.reject(new AtfRefusedError('not on the allow-list')) };
    const logged: string[] = [];
    const outcome = await startAtf(effect, {
      testRuns: { atfBatch: () => Promise.resolve({ ok: true, value: { status: 'ready', batch } }) },
      starter: refusing,
      boardOf: () => Promise.resolve({ atf: integration }),
      log: (_t: string, m: string) => logged.push(m),
    });
    expect(outcome).toBe('dropped');
    expect(logged.join('\n')).toContain('not on the allow-list');
  });

  it('drops the effect when the board went back to pull, a newer deploy replaced the commit, or the batch errors', async () => {
    expect(
      await run(
        { ok: true, value: { status: 'ready', batch } },
        { ...integration, mode: 'pull' },
      ).outcome(),
    ).toBe('dropped');
    expect(await run({ ok: true, value: { status: 'ready', batch } }, null).outcome()).toBe(
      'dropped',
    );
    expect(
      await run({ ok: true, value: { status: 'superseded', latestSha: 'b'.repeat(40) } }).outcome(),
    ).toBe('dropped');
    const failing = run({ ok: false, error: { code: 'not_found', message: 'No board 7' } });
    expect(await failing.outcome()).toBe('dropped');
    expect(failing.logged).toHaveLength(1);
    expect(starts).toEqual([]);
  });

  it('retries (throws) while the deploy is not checked yet', async () => {
    await expect(run({ ok: true, value: { status: 'pending' } }).outcome()).rejects.toThrow(
      /isn't checked yet/,
    );
  });
});
