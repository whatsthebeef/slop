import { beforeEach, describe, expect, it } from 'vitest';
import { AtfRunnerService } from '../src/app/atf-runner-service.js';
import type { RunnerCredentialIssuer, RunnerWebhooks } from '../src/app/atf-runner-service.js';
import { DeployService } from '../src/app/deploy-service.js';
import { publicRunner, validateRunner, webhookSubscribers } from '../src/domain/atf-runners.js';
import type { AtfRunner } from '../src/domain/atf-runners.js';
import {
  addressRefusal,
  deployLiveBody,
  validateWebhookUrl,
  webhookDeliveryId,
  webhookSignedText,
} from '../src/domain/atf-webhooks.js';
import type { Result } from '../src/domain/errors.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob } from './fixtures.js';

const ADMIN = 'admin@example.com';
const START = '2026-10-05T12:00:00.000Z';
const URL_OK = 'https://ci.example.com/hooks/slop';

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const errorCode = (r: Result<unknown>) => (r.ok ? 'ok' : r.error.code);

describe('addresses a webhook may not reach', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    '2001::1',
    '[::1]',
    'fe80::1%eth0',
  ])('refuses %s', (ip) => {
    expect(addressRefusal(ip)).not.toBeNull();
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '172.32.0.1',
    '100.63.255.255',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '2002:808:808::',
  ])('allows the public address %s', (ip) => {
    expect(addressRefusal(ip)).toBeNull();
  });

  it('refuses what is not an address', () => {
    expect(addressRefusal('example.com')).not.toBeNull();
    expect(addressRefusal('1.2.3')).not.toBeNull();
    expect(addressRefusal('999.1.1.1')).not.toBeNull();
    expect(addressRefusal('1::2::3')).not.toBeNull();
  });
});

describe('webhook URL validation', () => {
  it('accepts an https URL on a public host, with a port, path and query', () => {
    expect(validateWebhookUrl(URL_OK).ok).toBe(true);
    expect(validateWebhookUrl('https://vendor.example.org:8443/a/b?x=1').ok).toBe(true);
    expect(validateWebhookUrl('https://93.184.216.34/hook').ok).toBe(true);
  });

  it.each([
    ['http://ci.example.com/hook', 'plain http'],
    ['ftp://ci.example.com/hook', 'another scheme'],
    ['not a url', 'garbage'],
    ['https://user:pw@ci.example.com/hook', 'credentials in the URL'],
    ['https://localhost/hook', 'localhost'],
    ['https://app.localhost/hook', 'a localhost name'],
    ['https://intranet/hook', 'a single-label host'],
    ['https://db.internal/hook', 'an internal name'],
    ['https://127.0.0.1/hook', 'loopback'],
    ['https://2130706433/hook', 'loopback in decimal form'],
    ['https://0x7f.1/hook', 'loopback in hex form'],
    ['https://10.0.0.5/hook', 'a private address'],
    ['https://169.254.169.254/latest/meta-data', 'the metadata address'],
    ['https://[::1]/hook', 'IPv6 loopback'],
    ['https://[::ffff:10.0.0.1]/hook', 'a mapped private address'],
    [`https://ci.example.com/${'a'.repeat(500)}`, 'an oversized URL'],
  ])('refuses %s (%s)', (url) => {
    expect(errorCode(validateWebhookUrl(url))).toBe('invalid_input');
  });
});

describe('the deploy-live event', () => {
  it('is the board, environment, commit, deploy and time as JSON, with the delivery ID', () => {
    const body = deployLiveBody({
      boardId: 7,
      boardName: 'demo',
      environment: 'staging',
      sha: 'a'.repeat(40),
      deployId: 'dep-12',
      deployedAt: START,
      deliveryId: webhookDeliveryId(3, 'dep-12'),
    });
    expect(JSON.parse(body)).toEqual({
      event: 'deploy.live',
      id: 'atf-3-dep-12',
      board: { id: 7, name: 'demo' },
      environment: 'staging',
      sha: 'a'.repeat(40),
      deployId: 'dep-12',
      deployedAt: START,
    });
  });

  it('signs the timestamp, a dot and the exact body', () => {
    expect(webhookSignedText(1_700_000_000, '{"a":1}')).toBe('1700000000.{"a":1}');
  });
});

describe('runner webhook config', () => {
  const check = (config: Parameters<typeof validateRunner>[0]['config']) =>
    validateRunner(
      { name: 'Vendor', method: 'client_credentials', config, environments: ['staging'] },
      ['staging'],
    );

  it('is checked for any method, and an unusable URL refuses the runner', () => {
    expect(check({ webhook: { url: URL_OK } }).ok).toBe(true);
    expect(errorCode(check({ webhook: { url: 'http://ci.example.com/x' } }))).toBe('invalid_input');
    expect(errorCode(check({ webhook: { url: 'https://10.0.0.1/x' } }))).toBe('invalid_input');
    expect(
      errorCode(
        validateRunner(
          {
            name: 'GH',
            method: 'aws_iam',
            config: {
              roleArns: ['arn:aws:iam::123456789012:role/x'],
              webhook: { url: 'https://localhost/x' },
            },
            environments: ['staging'],
          },
          ['staging'],
        ),
      ),
    ).toBe('invalid_input');
  });

  it('hides the sealed secret from what the API shows, and only then', () => {
    const runner: AtfRunner = {
      id: 1,
      boardId: 1,
      name: 'r',
      method: 'client_credentials',
      config: { clientId: 'c', webhook: { url: URL_OK, secret: 'sealed' } },
      environments: ['staging'],
      enabled: true,
      createdBy: ADMIN,
      createdAt: START,
      revokedAt: null,
      lastSeenAt: null,
      lastResultAt: null,
    };
    expect(publicRunner(runner).config).toEqual({ clientId: 'c', webhook: { url: URL_OK } });
    expect(publicRunner({ ...runner, config: { clientId: 'c' } })).toEqual({
      ...runner,
      config: { clientId: 'c' },
    });
  });

  it('subscribes usable runners that serve the environment and have a secret', () => {
    const base: AtfRunner = {
      id: 1,
      boardId: 1,
      name: 'r',
      method: 'oidc',
      config: { webhook: { url: URL_OK, secret: 's' } },
      environments: ['staging'],
      enabled: true,
      createdBy: ADMIN,
      createdAt: START,
      revokedAt: null,
      lastSeenAt: null,
      lastResultAt: null,
    };
    const runners = [
      base,
      { ...base, id: 2, enabled: false },
      { ...base, id: 3, revokedAt: START },
      { ...base, id: 4, environments: ['prod'] },
      { ...base, id: 5, config: {} },
      { ...base, id: 6, config: { webhook: { url: URL_OK } } },
    ];
    expect(webhookSubscribers(runners, 'staging').map((r) => r.id)).toEqual([1]);
  });
});

describe('the registry and webhooks', () => {
  let store: MemoryStore;
  let boardId: number;
  let service: AtfRunnerService;
  let targets: string[];
  let refuse: string | null;
  let counter: number;

  const webhooks: RunnerWebhooks = {
    newSecret: () => `whsec_${String((counter += 1))}`,
    seal: (secret) => `sealed(${secret})`,
    checkTarget: (url) => {
      targets.push(url);
      return Promise.resolve(refuse);
    },
  };
  const issuer: RunnerCredentialIssuer = {
    issue: () =>
      Promise.resolve({ clientId: 'cid', clientSecret: 'shh', tokenUrl: 'https://t', scope: 's' }),
    revoke: () => Promise.resolve(),
  };
  const make = (extra: Partial<ConstructorParameters<typeof AtfRunnerService>[0]> = {}) =>
    new AtfRunnerService({ store, clock: { now: () => START }, webhooks, ...extra });
  const input = (config: Record<string, unknown>) => ({
    name: 'Vendor',
    method: 'aws_iam' as const,
    config: { roleArns: ['arn:aws:iam::123456789012:role/x'], ...config },
    environments: ['staging'],
  });
  const stored = async (id: number) => store.transaction((tx) => tx.getAtfRunner(boardId, id));

  beforeEach(async () => {
    store = new MemoryStore();
    targets = [];
    refuse = null;
    counter = 0;
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: ADMIN, active: true });
      const board = await tx.insertBoard({
        name: 'b',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [{ name: 'staging', allowBranchDeploy: true }],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
      return board.id;
    });
    service = make();
  });

  it('turns a webhook on at registration: the secret is shown once, only its sealed form is stored and listed nowhere', async () => {
    const created = unwrap(
      await service.create(ADMIN, boardId, input({ webhook: { url: URL_OK } })),
    );
    expect(created.webhookSecret).toBe('whsec_1');
    expect(created.config.webhook).toEqual({ url: URL_OK });
    expect((await stored(created.id))?.config.webhook).toEqual({
      url: URL_OK,
      secret: 'sealed(whsec_1)',
    });
    expect(targets).toEqual([URL_OK]);
    const listed = unwrap(await service.list(ADMIN, boardId));
    expect(listed[0]?.config.webhook).toEqual({ url: URL_OK });
    expect(JSON.stringify(listed)).not.toContain('sealed');
    expect(JSON.stringify(created)).not.toContain('sealed');
  });

  it('ignores a secret the caller sends: the signing secret is slop’s', async () => {
    const created = unwrap(
      await service.create(ADMIN, boardId, input({ webhook: { url: URL_OK, secret: 'mine' } })),
    );
    expect((await stored(created.id))?.config.webhook?.secret).toBe('sealed(whsec_1)');
  });

  it('refuses an unusable URL, a host that resolves to a private address and a server that cannot sign', async () => {
    expect(
      errorCode(
        await service.create(
          ADMIN,
          boardId,
          input({ webhook: { url: 'http://ci.example.com/x' } }),
        ),
      ),
    ).toBe('invalid_input');
    expect(
      errorCode(
        await service.create(ADMIN, boardId, input({ webhook: { url: 'https://127.0.0.1/x' } })),
      ),
    ).toBe('invalid_input');
    expect(targets).toEqual([]);
    refuse = 'The host ci.example.com resolves to a private or reserved address';
    expect(
      errorCode(await service.create(ADMIN, boardId, input({ webhook: { url: URL_OK } }))),
    ).toBe('invalid_input');
    const unsigned = make({ webhooks: undefined });
    expect(
      errorCode(await unsigned.create(ADMIN, boardId, input({ webhook: { url: URL_OK } }))),
    ).toBe('invalid_combination');
    expect(unwrap(await service.list(ADMIN, boardId))).toEqual([]);
  });

  it('gives a non-admin the same refusal as any other call and never looks the webhook host up', async () => {
    const outsider = 'outsider@example.com';
    await store.transaction((tx) =>
      tx.upsertUser({ email: outsider, name: outsider, active: true }),
    );
    const runner = unwrap(await service.create(ADMIN, boardId, input({})));
    targets.length = 0;
    const plain = await service.create(outsider, boardId, input({}));
    expect(plain.ok).toBe(false);
    for (const url of ['https://127.0.0.1/x', 'http://nope.invalid/x', URL_OK]) {
      refuse = 'The host resolves to a private or reserved address';
      const created = await service.create(outsider, boardId, input({ webhook: { url } }));
      expect(created).toEqual(plain);
      const updated = await service.update(outsider, boardId, runner.id, {
        config: { roleArns: ['arn:aws:iam::123456789012:role/x'], webhook: { url } },
      });
      expect(updated).toEqual(plain);
    }
    expect(targets).toEqual([]);
  });

  it('makes no secret for a runner without a webhook', async () => {
    const created = unwrap(await service.create(ADMIN, boardId, input({})));
    expect(created.webhookSecret).toBeUndefined();
    expect(created.config.webhook).toBeUndefined();
  });

  it('turns it on later with a new secret shown once, keeps the secret when the URL moves, and off when it is left out', async () => {
    const runner = unwrap(await service.create(ADMIN, boardId, input({})));
    const on = unwrap(
      await service.update(ADMIN, boardId, runner.id, {
        config: { roleArns: ['arn:aws:iam::123456789012:role/x'], webhook: { url: URL_OK } },
      }),
    );
    expect(on.webhookSecret).toBe('whsec_1');
    const same = unwrap(await service.update(ADMIN, boardId, runner.id, { enabled: false }));
    expect(same.webhookSecret).toBeUndefined();
    expect((await stored(runner.id))?.config.webhook).toEqual({
      url: URL_OK,
      secret: 'sealed(whsec_1)',
    });
    const moved = unwrap(
      await service.update(ADMIN, boardId, runner.id, {
        config: {
          roleArns: ['arn:aws:iam::123456789012:role/x'],
          webhook: { url: 'https://other.example.com/h' },
        },
      }),
    );
    expect(moved.webhookSecret).toBeUndefined();
    expect((await stored(runner.id))?.config.webhook).toEqual({
      url: 'https://other.example.com/h',
      secret: 'sealed(whsec_1)',
    });
    expect(targets).toEqual([URL_OK, 'https://other.example.com/h']);
    unwrap(
      await service.update(ADMIN, boardId, runner.id, {
        config: { roleArns: ['arn:aws:iam::123456789012:role/x'] },
      }),
    );
    expect((await stored(runner.id))?.config.webhook).toBeUndefined();
    const again = unwrap(
      await service.update(ADMIN, boardId, runner.id, {
        config: { roleArns: ['arn:aws:iam::123456789012:role/x'], webhook: { url: URL_OK } },
      }),
    );
    expect(again.webhookSecret).toBe('whsec_2');
  });

  it('does not look the host up again for an unchanged URL', async () => {
    const runner = unwrap(
      await service.create(ADMIN, boardId, input({ webhook: { url: URL_OK } })),
    );
    refuse = 'resolves to a private address now';
    unwrap(
      await service.update(ADMIN, boardId, runner.id, {
        name: 'Renamed',
        config: { roleArns: ['arn:aws:iam::123456789012:role/x'], webhook: { url: URL_OK } },
      }),
    );
    expect(targets).toEqual([URL_OK]);
  });

  it('keeps the webhook on a client-credentials runner whose client the provider issues, through create and update', async () => {
    const withIssuer = make({ issuer });
    const created = unwrap(
      await withIssuer.create(ADMIN, boardId, {
        name: 'CC',
        method: 'client_credentials',
        environments: ['staging'],
        config: { webhook: { url: URL_OK } },
      }),
    );
    expect(created.credentials?.clientId).toBe('cid');
    expect(created.webhookSecret).toBe('whsec_1');
    expect((await stored(created.id))?.config).toEqual({
      clientId: 'cid',
      webhook: { url: URL_OK, secret: 'sealed(whsec_1)' },
    });
    unwrap(
      await withIssuer.update(ADMIN, boardId, created.id, {
        environments: ['staging'],
        config: { clientId: 'evil', webhook: { url: URL_OK } },
      }),
    );
    expect((await stored(created.id))?.config.clientId).toBe('cid');
    expect((await stored(created.id))?.config.webhook?.secret).toBe('sealed(whsec_1)');
  });

  it('shows the secret to admins only', async () => {
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: 'dev@example.com', name: 'd', active: true });
      await tx.upsertMember({ boardId, email: 'dev@example.com', role: 'dev' });
    });
    expect(
      errorCode(
        await service.create('dev@example.com', boardId, input({ webhook: { url: URL_OK } })),
      ),
    ).toBe('forbidden');
  });
});

describe('queuing deploy-live deliveries when a branch deploy succeeds', () => {
  let store: MemoryStore;
  let deploys: DeployService;
  let boardId: number;
  let runnerIds: Record<string, number>;
  let n: number;
  const SHA = 'a'.repeat(40);

  /** A branch deploy of the glob's commit, run to the end. */
  const deploy = async (globId: string, sha: string, succeeded = true) => {
    const requested = unwrap(await deploys.requestFromPush(globId, sha));
    const id = requested?.id ?? '';
    unwrap(await deploys.finished(id, { succeeded, error: succeeded ? null : 'exit 1' }));
    return id;
  };
  const deliveries = () =>
    store.state.outbox.flatMap((e) => (e.kind === 'deliver_atf_webhook' ? [e] : []));

  beforeEach(async () => {
    store = new MemoryStore();
    n = 0;
    deploys = new DeployService({
      store,
      notifier: new RecordingNotifier(),
      clock: { now: () => START },
      newDeployId: () => `dep${String(++n)}`,
    });
    runnerIds = {};
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: ADMIN, active: true });
      const board = await tx.insertBoard({
        name: 'b',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [
          { name: 'dev', allowBranchDeploy: true },
          { name: 'qa', allowBranchDeploy: true },
        ],
        sensitivePaths: [],
      });
      const add = async (
        name: string,
        envs: string[],
        config: AtfRunner['config'],
        enabled = true,
      ) => {
        const runner = await tx.insertAtfRunner({
          boardId: board.id,
          name,
          method: 'oidc',
          config,
          environments: envs,
          enabled,
          createdBy: ADMIN,
          createdAt: START,
        });
        runnerIds[name] = runner?.id ?? 0;
      };
      const hook = { webhook: { url: URL_OK, secret: 'sealed' } };
      await add('a', ['dev'], hook);
      await add('b', ['dev', 'qa'], hook);
      await add('qa only', ['qa'], hook);
      await add('no hook', ['dev'], {});
      await add('off', ['dev'], hook, false);
      await add('url only', ['dev'], { webhook: { url: URL_OK } });
      for (const id of ['s1t1', 's1t2']) {
        await tx.insertGlob(glob({ id, boardId: board.id, environment: 'dev', status: 'in_progress' }), null);
      }
      return board.id;
    });
    // insertBoard does not take a deploy integration; a branch deploy needs one.
    const board = store.state.boards.get(boardId);
    if (board !== undefined) {
      store.state.boards.set(boardId, {
        ...board,
        deploy: { provider: 'codebuild', region: 'us-east-1', defaultProject: 'deploy', projects: {} },
      });
    }
  });

  it('queues one delivery per subscribed runner that serves the environment, carrying the deploy', async () => {
    const deployId = await deploy('s1t1', SHA);
    expect(deliveries()).toEqual(
      ['a', 'b'].map((name) => ({
        kind: 'deliver_atf_webhook',
        globId: `board-${String(boardId)}`,
        boardId,
        runnerId: runnerIds[name],
        deployId,
        environment: 'dev',
        sha: SHA,
        deployedAt: START,
      })),
    );
  });

  it('queues nothing for a revoked runner or a failed deploy', async () => {
    await store.transaction((tx) =>
      tx.updateAtfRunner(boardId, runnerIds['a'] ?? 0, { enabled: false, revokedAt: START }),
    );
    await deploy('s1t1', SHA);
    expect(deliveries().map((e) => e.runnerId)).toEqual([runnerIds['b']]);
    store.state.outbox.length = 0;
    await deploy('s1t2', 'b'.repeat(40), false);
    expect(deliveries()).toEqual([]);
  });

  it('queues one delivery per runner and deploy: a repeated result queues nothing new', async () => {
    const first = await deploy('s1t1', SHA);
    unwrap(await deploys.finished(first, { succeeded: true, error: null }));
    expect(deliveries()).toHaveLength(2);
    await deploy('s1t2', 'c'.repeat(40));
    expect(deliveries()).toHaveLength(4);
  });
});
