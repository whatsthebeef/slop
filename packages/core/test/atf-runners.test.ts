import { beforeEach, describe, expect, it } from 'vitest';
import { AtfRunnerService } from '../src/app/atf-runner-service.js';
import type { RunnerInput } from '../src/app/atf-runner-service.js';
import { claimValueMatches, claimsMatch, validateRunner } from '../src/domain/atf-runners.js';
import type { AtfRunnerConfig } from '../src/domain/atf-runners.js';
import type { Result } from '../src/domain/errors.js';
import { MemoryStore } from '../src/testing/memory-store.js';

const ADMIN = 'admin@example.com';
const DEV = 'dev@example.com';
const START = '2026-10-05T12:00:00.000Z';
const GITHUB = 'https://token.actions.githubusercontent.com';

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const errorCode = (r: Result<unknown>) => (r.ok ? 'ok' : r.error.code);
const errorMessage = (r: Result<unknown>) => (r.ok ? '' : r.error.message);

const OBSERVED = ['staging', 'prod'];
const github = (claims: AtfRunnerConfig['claims']): AtfRunnerConfig => ({
  issuer: GITHUB,
  ...(claims !== undefined && { claims }),
});

describe('claim rules', () => {
  it('match a value exactly, or by prefix with a trailing star', () => {
    expect(claimValueMatches('acme/app', 'acme/app')).toBe(true);
    expect(claimValueMatches('acme/app', 'acme/app2')).toBe(false);
    expect(claimValueMatches('acme/*', 'acme/app')).toBe(true);
    expect(claimValueMatches('acme/*', 'other/app')).toBe(false);
    expect(
      claimValueMatches('repo:acme/app:ref:refs/heads/*', 'repo:acme/app:ref:refs/heads/main'),
    ).toBe(true);
  });

  it('need every rule to hold, read a list claim by any of its values, and treat a missing claim as no match', () => {
    const rules = {
      repository: ['acme/app'],
      ref: ['refs/heads/main', 'refs/tags/v*'],
      aud: ['slop'],
    };
    expect(
      claimsMatch(rules, { repository: 'acme/app', ref: 'refs/tags/v1', aud: ['other', 'slop'] }),
    ).toBe(true);
    expect(claimsMatch(rules, { repository: 'acme/app', ref: 'refs/heads/dev', aud: 'slop' })).toBe(
      false,
    );
    expect(claimsMatch(rules, { repository: 'acme/app', ref: 'refs/heads/main' })).toBe(false);
    expect(claimsMatch(rules, { repository: 7, ref: 'refs/heads/main', aud: 'slop' })).toBe(false);
  });

  it('match nothing when there are no rules', () => {
    expect(claimsMatch({}, { repository: 'acme/app' })).toBe(false);
  });
});

describe('runner validation', () => {
  const check = (patch: Partial<Parameters<typeof validateRunner>[0]>) =>
    validateRunner(
      {
        name: 'GitHub',
        method: 'oidc',
        config: github({ repository: ['acme/app'] }),
        environments: ['staging'],
        ...patch,
      },
      OBSERVED,
    );

  it('accepts a GitHub runner that pins the repository or the sub claim, by prefix too', () => {
    expect(check({}).ok).toBe(true);
    expect(check({ config: github({ sub: ['repo:acme/app:*'] }) }).ok).toBe(true);
    expect(check({ config: github({ repository: ['acme/*'], ref: ['refs/heads/main'] }) }).ok).toBe(
      true,
    );
  });

  it('refuses a GitHub runner without a pin, however many other rules it has', () => {
    expect(errorCode(check({ config: github({}) }))).toBe('invalid_input');
    expect(
      errorMessage(
        check({ config: github({ ref: ['refs/heads/main'], workflow_ref: ['acme/app/*'] }) }),
      ),
    ).toContain('pin the repository');
  });

  it('refuses a rule that would match every value, an empty one, and a star in the middle', () => {
    expect(errorCode(check({ config: github({ repository: ['*'] }) }))).toBe('invalid_input');
    expect(errorCode(check({ config: github({ repository: [] }) }))).toBe('invalid_input');
    expect(errorCode(check({ config: github({ repository: ['acme/*/app'] }) }))).toBe(
      'invalid_input',
    );
  });

  it('needs an https issuer and at least one claim rule for any OIDC runner', () => {
    expect(errorCode(check({ config: { claims: { sub: ['x'] } } }))).toBe('invalid_input');
    expect(
      errorCode(check({ config: { issuer: 'http://ci.example.com', claims: { sub: ['x'] } } })),
    ).toBe('invalid_input');
    expect(errorCode(check({ config: { issuer: 'https://ci.example.com' } }))).toBe(
      'invalid_input',
    );
    expect(
      check({ config: { issuer: 'https://ci.example.com', claims: { project: ['p-1'] } } }).ok,
    ).toBe(true);
  });

  it('only serves environments the board observes, at least one, without repeats', () => {
    expect(errorMessage(check({ environments: ['dev'] }))).toContain("dev isn't an environment");
    expect(errorCode(check({ environments: [] }))).toBe('invalid_input');
    expect(unwrap(check({ environments: ['staging', 'staging'] })).environments).toEqual([
      'staging',
    ]);
  });

  it('needs a trimmed name of reasonable length', () => {
    expect(errorCode(check({ name: '   ' }))).toBe('invalid_input');
    expect(errorCode(check({ name: 'x'.repeat(101) }))).toBe('invalid_input');
    expect(unwrap(check({ name: '  CI  ' })).name).toBe('CI');
  });

  it('checks the role ARNs of an AWS IAM runner, and lets a client-credentials runner wait for its client', () => {
    const aws = (config: AtfRunnerConfig) => check({ method: 'aws_iam', config });
    expect(aws({ roleArns: ['arn:aws:iam::123456789012:role/atf-codebuild'] }).ok).toBe(true);
    expect(errorCode(aws({}))).toBe('invalid_input');
    expect(errorCode(aws({ roleArns: ['role/atf'] }))).toBe('invalid_input');
    expect(
      errorCode(aws({ roleArns: ['arn:aws:iam::123456789012:role/x'], accounts: ['123'] })),
    ).toBe('invalid_input');
    expect(check({ method: 'client_credentials', config: {} }).ok).toBe(true);
  });
});

describe('the ATF runner registry', () => {
  let store: MemoryStore;
  let service: AtfRunnerService;
  let boardId: number;
  let otherBoardId: number;
  let now = START;

  const input = (patch: Partial<RunnerInput> = {}): RunnerInput => ({
    name: 'GitHub Actions',
    method: 'oidc',
    config: github({ repository: ['acme/app'] }),
    environments: ['staging'],
    ...patch,
  });

  beforeEach(async () => {
    store = new MemoryStore();
    now = START;
    service = new AtfRunnerService({ store, clock: { now: () => now } });
    [boardId, otherBoardId] = await store.transaction(async (tx) => {
      for (const email of [ADMIN, DEV]) await tx.upsertUser({ email, name: email, active: true });
      const make = () =>
        tx.insertBoard({
          name: 'b',
          repo: 'acme/app',
          baseBranch: 'main',
          timeZone: 'UTC',
          defaultRoutineOwner: null,
          environments: [
            { name: 'dev', allowBranchDeploy: true },
            { name: 'staging', allowBranchDeploy: false, role: 'integration' },
            { name: 'prod', allowBranchDeploy: false, role: 'release' },
          ],
          sensitivePaths: [],
        });
      const a = await make();
      const b = await make();
      await tx.upsertMember({ boardId: a.id, email: ADMIN, role: 'admin' });
      await tx.upsertMember({ boardId: a.id, email: DEV, role: 'dev' });
      return [a.id, b.id];
    });
  });

  it('lets only a board admin register, list, change and revoke runners', async () => {
    const runner = unwrap(await service.create(ADMIN, boardId, input()));
    expect(errorCode(await service.create(DEV, boardId, input({ name: 'Other' })))).toBe(
      'forbidden',
    );
    expect(errorCode(await service.create(ADMIN, otherBoardId, input({ name: 'Other' })))).toBe(
      'forbidden',
    );
    expect(errorCode(await service.list(DEV, boardId))).toBe('forbidden');
    expect(errorCode(await service.update(DEV, boardId, runner.id, { enabled: false }))).toBe(
      'forbidden',
    );
    expect(errorCode(await service.revoke(DEV, boardId, runner.id))).toBe('forbidden');
    expect(unwrap(await service.list(ADMIN, boardId)).map((r) => r.id)).toEqual([runner.id]);
  });

  it('records who registered it and starts it enabled, with only the settings of its method', async () => {
    const runner = unwrap(
      await service.create(
        ADMIN,
        boardId,
        input({
          config: {
            ...github({ repository: ['acme/app'] }),
            clientId: 'leftover',
            roleArns: ['arn:aws:iam::123456789012:role/x'],
          },
        }),
      ),
    );
    expect(runner).toMatchObject({
      boardId,
      name: 'GitHub Actions',
      method: 'oidc',
      enabled: true,
      createdBy: ADMIN,
      createdAt: START,
      revokedAt: null,
      lastSeenAt: null,
    });
    expect(runner.config).toEqual({ issuer: GITHUB, claims: { repository: ['acme/app'] } });
  });

  it('keeps names unique per board without regard to case, and frees one when its runner is revoked', async () => {
    const first = unwrap(await service.create(ADMIN, boardId, input()));
    expect(errorCode(await service.create(ADMIN, boardId, input({ name: 'github actions' })))).toBe(
      'invalid_input',
    );
    // Another board may use the name.
    await store.transaction((tx) =>
      tx.upsertMember({ boardId: otherBoardId, email: ADMIN, role: 'admin' }),
    );
    unwrap(await service.create(ADMIN, otherBoardId, input()));
    unwrap(await service.revoke(ADMIN, boardId, first.id));
    unwrap(await service.create(ADMIN, boardId, input()));
  });

  it('refuses a rename onto another active runner’s name', async () => {
    unwrap(await service.create(ADMIN, boardId, input()));
    const second = unwrap(
      await service.create(ADMIN, boardId, input({ name: 'Second', environments: ['prod'] })),
    );
    expect(
      errorCode(await service.update(ADMIN, boardId, second.id, { name: 'GITHUB ACTIONS' })),
    ).toBe('invalid_input');
    expect(unwrap(await service.update(ADMIN, boardId, second.id, { name: 'Renamed' })).name).toBe(
      'Renamed',
    );
  });

  it('applies the validation rules to a change too: a pin can’t be dropped, environments must be observed', async () => {
    const runner = unwrap(await service.create(ADMIN, boardId, input()));
    expect(
      errorCode(
        await service.update(ADMIN, boardId, runner.id, {
          config: github({ ref: ['refs/heads/main'] }),
        }),
      ),
    ).toBe('invalid_input');
    expect(
      errorCode(await service.update(ADMIN, boardId, runner.id, { environments: ['dev'] })),
    ).toBe('invalid_input');
    const changed = unwrap(
      await service.update(ADMIN, boardId, runner.id, {
        environments: ['staging', 'prod'],
        config: github({ repository: ['acme/*'] }),
      }),
    );
    expect(changed.environments).toEqual(['staging', 'prod']);
    expect(changed.method).toBe('oidc');
  });

  it('disables and enables a runner, and revoking is for good and touches no other runner', async () => {
    const a = unwrap(await service.create(ADMIN, boardId, input()));
    const b = unwrap(await service.create(ADMIN, boardId, input({ name: 'Second' })));
    expect(unwrap(await service.update(ADMIN, boardId, a.id, { enabled: false })).enabled).toBe(
      false,
    );
    expect(unwrap(await service.update(ADMIN, boardId, a.id, { enabled: true })).enabled).toBe(
      true,
    );
    now = '2026-10-06T08:00:00.000Z';
    const revoked = unwrap(await service.revoke(ADMIN, boardId, a.id));
    expect(revoked).toMatchObject({ enabled: false, revokedAt: now });
    expect(errorCode(await service.update(ADMIN, boardId, a.id, { enabled: true }))).toBe(
      'invalid_input',
    );
    // Revoking again changes nothing; the list keeps only the others; the other runner is untouched.
    expect(unwrap(await service.revoke(ADMIN, boardId, a.id)).revokedAt).toBe(now);
    expect(unwrap(await service.list(ADMIN, boardId)).map((r) => r.id)).toEqual([b.id]);
    expect((await store.transaction((tx) => tx.getAtfRunner(boardId, b.id)))?.enabled).toBe(true);
    // Its row stays for the runs that point at it.
    expect(
      await store.transaction((tx) => tx.listAtfRunners(boardId, { includeRevoked: true })),
    ).toHaveLength(2);
  });

  it('binds a runner to its board: another board’s admin can’t reach it', async () => {
    const runner = unwrap(await service.create(ADMIN, boardId, input()));
    await store.transaction((tx) =>
      tx.upsertMember({ boardId: otherBoardId, email: ADMIN, role: 'admin' }),
    );
    expect(
      errorCode(await service.update(ADMIN, otherBoardId, runner.id, { enabled: false })),
    ).toBe('not_found');
    expect(errorCode(await service.revoke(ADMIN, otherBoardId, runner.id))).toBe('not_found');
  });

  it('notes when a runner was last seen', async () => {
    const runner = unwrap(await service.create(ADMIN, boardId, input()));
    now = '2026-10-05T12:30:00.000Z';
    await service.seen(boardId, runner.id);
    expect((await store.transaction((tx) => tx.getAtfRunner(boardId, runner.id)))?.lastSeenAt).toBe(
      now,
    );
  });
});
