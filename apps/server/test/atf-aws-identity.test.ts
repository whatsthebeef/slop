import { AtfRunnerService } from '@slop/core';
import type { AtfRunner, Board } from '@slop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOidcRunnerVerifier } from '../src/atf-oidc.js';
import type { RunnerVerifier } from '../src/atf-auth.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import { startIssuer } from './support/atf-issuer.js';
import type { TestIssuer } from './support/atf-issuer.js';
import { createTestDatabase } from './support/database.js';

const ADMIN = 'admin@example.com';
const AUDIENCE = 'https://slop.example.com';
const ACCOUNT = '111122223333';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/atf-codebuild`;

describe('AWS IAM runner identity (outbound identity federation)', () => {
  let database: Database;
  let drop: () => Promise<void>;
  let store: PgStore;
  let runners: AtfRunnerService;
  let board: Board;
  let aws: TestIssuer;
  let runner: AtfRunner;

  const verifier = (accounts: string[] = [ACCOUNT]): RunnerVerifier => {
    const made = createOidcRunnerVerifier({
      store,
      oidcIssuers: [],
      awsIssuers: [aws.issuer],
      awsAccounts: accounts,
      audience: AUDIENCE,
      fetcher: aws.fetcher(),
    });
    if (made === null) throw new Error('no verifier');
    return made;
  };
  const token = (sub: string, extra: Record<string, unknown> = {}) =>
    aws.token({ aud: AUDIENCE, sub, aws_account: sub.split(':')[4] ?? '', ...extra });

  beforeAll(async () => {
    ({ database, drop } = await createTestDatabase('atf_aws'));
    store = new PgStore(database.db);
    runners = new AtfRunnerService({ store, clock: { now: () => '2026-10-05T13:00:00.000Z' } });
    await store.transaction(async (tx) => {
      await tx.upsertUser({ email: ADMIN, name: 'Admin', active: true });
      board = await tx.insertBoard({
        name: 'sandbox',
        repo: 'acme/sandbox',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [{ name: 'staging', allowBranchDeploy: true }],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: ADMIN, role: 'admin' });
    });
    aws = await startIssuer('abc123.tokens.sts.global.api', 'RS256');
    const created = await runners.create(ADMIN, board.id, {
      name: 'codebuild',
      method: 'aws_iam',
      config: { roleArns: [ROLE] },
      environments: ['staging'],
    });
    if (!created.ok) throw new Error(created.error.message);
    runner = created.value;
  });

  afterAll(async () => {
    await aws.close();
    await drop();
  });

  it('accepts a token for an allow-listed account whose role ARN is the runner’s', async () => {
    expect(await verifier()(board.id, token(ROLE))).toMatchObject({
      runnerId: runner.id,
      method: 'aws_iam',
      environments: ['staging'],
    });
  });

  it('accepts the assumed-role ARN of a session of that role', async () => {
    const session = `arn:aws:sts::${ACCOUNT}:assumed-role/atf-codebuild/AWSCodeBuild-1234`;
    expect((await verifier()(board.id, token(session)))?.runnerId).toBe(runner.id);
  });

  it('reads the account from the namespaced claim when there is no top-level one', async () => {
    const t = aws.token({
      aud: AUDIENCE,
      sub: ROLE,
      'https://sts.amazonaws.com/': { aws_account: ACCOUNT },
    });
    expect((await verifier()(board.id, t))?.runnerId).toBe(runner.id);
  });

  it('refuses a role in an account the server does not allow, even if the runner lists it', async () => {
    const other = '999988887777';
    const arn = `arn:aws:iam::${other}:role/atf-codebuild`;
    const created = await runners.create(ADMIN, board.id, {
      name: 'foreign',
      method: 'aws_iam',
      config: { roleArns: [arn] },
      environments: ['staging'],
    });
    expect(created.ok).toBe(true);
    expect(await verifier()(board.id, token(arn))).toBeNull();
    expect((await verifier([ACCOUNT, other])(board.id, token(arn)))?.runnerId).toBe(
      created.ok ? created.value.id : -1,
    );
  });

  it('refuses a role ARN that is not on the runner, another role, a user and a claimed account that disagrees', async () => {
    const verify = verifier();
    expect(await verify(board.id, token(`arn:aws:iam::${ACCOUNT}:role/someone-else`))).toBeNull();
    expect(await verify(board.id, token(`arn:aws:iam::${ACCOUNT}:user/atf-codebuild`))).toBeNull();
    expect(await verify(board.id, token(ROLE, { aws_account: '999988887777' }))).toBeNull();
  });

  it('refuses the wrong audience, and treats an AWS issuer token as no OIDC runner’s', async () => {
    expect(
      await verifier()(board.id, token(ROLE, { aud: 'https://elsewhere.example.com' })),
    ).toBeNull();
    const asOidc = await runners.create(ADMIN, board.id, {
      name: 'oidc-lookalike',
      method: 'oidc',
      config: { issuer: aws.issuer, claims: { sub: [ROLE] } },
      environments: ['staging'],
    });
    expect(asOidc.ok).toBe(true);
    // The AWS issuer is only on the AWS list, so an oidc runner naming it never matches; the aws_iam runner still does.
    expect((await verifier()(board.id, token(ROLE)))?.runnerId).toBe(runner.id);
  });

  it('refuses once the runner is disabled', async () => {
    await runners.update(ADMIN, board.id, runner.id, { enabled: false });
    expect(await verifier()(board.id, token(ROLE))).toBeNull();
    await runners.update(ADMIN, board.id, runner.id, { enabled: true });
  });
});
