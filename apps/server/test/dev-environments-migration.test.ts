import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, runMigrations } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://slop:slop@localhost:5432/slop';
const DB = `slop_test_devenvs_${process.pid}`;
const URL_ = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const TAG = '0085_dev_environments_only';

const board14 = [
  { name: 'dev', allowBranchDeploy: true },
  { name: 'danzig', allowBranchDeploy: true },
  { name: 'demo', allowBranchDeploy: true },
  { name: 'int', allowBranchDeploy: false, role: 'integration', deployKnown: true, subDefault: true },
  { name: 'staging', allowBranchDeploy: false, role: 'staging', deployKnown: true },
  { name: 'prod', allowBranchDeploy: false, role: 'production', production: true, deployKnown: false },
];
const board15 = [{ name: 'main', allowBranchDeploy: false }];

/** The migration that keeps only roleless environments, against Postgres: migrated up to the one before, board 14 and 15 shaped rows, then it. */
describe('dev environments only (migration 0085)', () => {
  let admin: Database;
  let database: Database;

  const run = (q: ReturnType<typeof sql>) => database.db.execute(q);
  const step = async (id: string, boardId: number, globId: string, title: string, due: string, state = 'open', blocks: string[] = ['sign_off']) => {
    await run(sql`insert into human_steps (id, board_id, glob_id, kind, title, who, due, state, blocks, origin, created_by, created_at)
      values (${id}, ${boardId}, ${globId}, 'rollout', ${title}, 'admin', ${due}, ${state}, ${JSON.stringify(blocks)}::jsonb, 'plan', 'x', now())`);
  };
  const stepRow = async (id: string) => (await run(sql`select title, due, state, blocks from human_steps where id = ${id}`))[0];
  const tableExists = async (name: string) => (await run(sql`select to_regclass(${name}) as t`))[0]?.t !== null;

  beforeAll(async () => {
    admin = connect(ADMIN_URL);
    await admin.db.execute(sql.raw(`create database ${DB}`));
    const folder = await mkdtemp(join(tmpdir(), 'dev-envs-'));
    await cp(new URL('../drizzle', import.meta.url).pathname, folder, { recursive: true });
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    // The migration and every later one are held back, so that they run in order afterwards.
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === TAG));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await runMigrations(URL_, folder);
    database = connect(URL_);
    const deploy14 = { provider: 'codebuild', region: 'r', defaultProject: 'p', projects: { dev: 'pd', int: 'pi', staging: 'ps', prod: 'pp' } };
    await run(sql`insert into boards (id, name, base_branch, time_zone, environments, sensitive_paths, deploy, version) overriding system value
      values (14, 'b14', 'main', 'UTC', ${JSON.stringify(board14)}::jsonb, '[]'::jsonb, ${JSON.stringify(deploy14)}::jsonb, 1),
             (15, 'b15', 'main', 'UTC', ${JSON.stringify(board15)}::jsonb, '[]'::jsonb, null, 1)`);
    for (const g of ['s14t1', 's14t2', 's15t1'] as const) {
      await run(sql`insert into globs (id, board_id, version, status, type, planner, data, updated_at)
        values (${g}, ${g.startsWith('s14') ? 14 : 15}, 1, 'planning', 'same', 'x', '{}'::jsonb, now())`);
    }
    await step('h1', 14, 's14t1', 'Check int', 'after_deploy:int');
    await step('h2', 14, 's14t1', 'Check staging', 'after_deploy:staging', 'done');
    await step('h3', 14, 's14t2', 'Check prod', 'after_deploy:prod', 'dismissed', ['sign_off', 'merge']);
    await step('h4', 14, 's14t2', 'Check dev', 'after_deploy:dev');
    await step('h5', 14, 's14t2', 'Check unknown', 'after_deploy:qa');
    await step('h6', 15, 's15t1', 'Other board prod', 'after_deploy:prod');
    await step('h7', 14, 's14t2', 'After merge', 'after_merge');
    await run(sql`insert into atf_runners (board_id, name, method, environments, enabled, created_by, created_at) values
      (14, 'mixed', 'oidc', '["dev","int","prod"]'::jsonb, true, 'x', now()),
      (14, 'prodonly', 'oidc', '["staging","prod"]'::jsonb, true, 'x', now()),
      (14, 'any', 'oidc', '[]'::jsonb, true, 'x', now())`);
    await run(sql`insert into test_runs (board_id, kind, glob_id, environment, sha, passed, failed, event_id, finished_at) values
      (14, 'atf', null, 'prod', 'abc', 1, 0, 'e1', now()), (14, 'atf', 's14t1', 'dev', 'def', 1, 0, 'e2', now())`);
    await run(sql`insert into test_run_specs (test_run_id, spec, status) select id, 'a.spec', 'passed' from test_runs where event_id = 'e1'`);
    const job = (id: number, kind: string, state: string, effect: Record<string, unknown>) =>
      run(sql`insert into outbox (id, kind, glob_id, effect, state) overriding system value values (${id}, ${kind}, 'board-14', ${JSON.stringify(effect)}::jsonb, ${state})`);
    await job(1, 'check_environment', 'pending', { kind: 'check_environment' });
    await job(2, 'check_environment', 'failed', { kind: 'check_environment' });
    await job(3, 'check_environment', 'done', { kind: 'check_environment' });
    await job(4, 'deliver_atf_webhook', 'pending', { kind: 'deliver_atf_webhook', runnerId: 1, deployId: 7 });
    await job(5, 'deliver_atf_webhook', 'pending', { kind: 'deliver_atf_webhook', runnerId: 1, deployId: 'd7' });
    await job(6, 'deliver_atf_webhook', 'failed', { kind: 'deliver_atf_webhook', runnerId: 1, deployId: 8 });
    await runMigrations(URL_, new URL('../drizzle', import.meta.url).pathname);
  });

  afterAll(async () => {
    await database.close();
    await admin.db.execute(sql.raw(`drop database if exists ${DB} with (force)`));
    await admin.close();
  });

  it('keeps the roleless environments of board 14, in order and without the removed keys', async () => {
    const rows = await run(sql`select environments, deploy from boards where id = 14`);
    expect(rows[0]?.environments).toEqual([
      { name: 'dev', allowBranchDeploy: true },
      { name: 'danzig', allowBranchDeploy: true },
      { name: 'demo', allowBranchDeploy: true },
    ]);
    // Migration 0086 then drops the default project: environments without their own get it as theirs.
    expect(rows[0]?.deploy).toEqual({ provider: 'codebuild', region: 'r', projects: { dev: 'pd', danzig: 'p', demo: 'p' } });
  });

  it('leaves board 15 and the base branch alone', async () => {
    const rows = await run(sql`select environments, deploy, base_branch from boards where id = 15`);
    expect(rows[0]).toEqual({ environments: board15, deploy: null, base_branch: 'main' });
    expect((await run(sql`select base_branch from boards where id = 14`))[0]?.base_branch).toBe('main');
  });

  it('turns after_deploy steps of dropped environments into non-blocking downstream steps, in every state, titles kept', async () => {
    expect(await stepRow('h1')).toEqual({ title: 'Check int', due: 'downstream', state: 'open', blocks: [] });
    expect(await stepRow('h2')).toEqual({ title: 'Check staging', due: 'downstream', state: 'done', blocks: [] });
    expect(await stepRow('h3')).toEqual({ title: 'Check prod', due: 'downstream', state: 'dismissed', blocks: [] });
  });

  it('leaves steps of dev environments, unknown environments, other boards and other kinds alone', async () => {
    expect(await stepRow('h4')).toMatchObject({ due: 'after_deploy:dev', blocks: ['sign_off'] });
    expect(await stepRow('h5')).toMatchObject({ due: 'after_deploy:qa', blocks: ['sign_off'] });
    expect(await stepRow('h6')).toMatchObject({ due: 'after_deploy:prod', blocks: ['sign_off'] });
    expect(await stepRow('h7')).toMatchObject({ due: 'after_merge' });
  });

  it('frees a glob that only the converted steps held back from sign-off', async () => {
    const held = await run(sql`select count(*)::int as n from human_steps where glob_id = 's14t1' and state = 'open' and blocks ? 'sign_off'`);
    expect(held[0]?.n).toBe(0);
    // s14t2 is still held by its dev, unknown-environment and after-merge steps (h4, h5, h7).
    const other = await run(sql`select count(*)::int as n from human_steps where glob_id = 's14t2' and state = 'open' and blocks ? 'sign_off'`);
    expect(other[0]?.n).toBe(3);
  });

  it('removes the dropped names from runners and disables one left with none', async () => {
    const rows = await run(sql`select name, environments, enabled from atf_runners order by id`);
    expect(rows).toEqual([
      { name: 'mixed', environments: ['dev'], enabled: true },
      { name: 'prodonly', environments: [], enabled: false },
      { name: 'any', environments: [], enabled: true },
    ]);
  });

  it('deletes environment-commit runs and their specs, and keeps glob runs', async () => {
    expect((await run(sql`select event_id from test_runs`)).map((r) => r.event_id)).toEqual(['e2']);
    expect((await run(sql`select count(*)::int as n from test_run_specs`))[0]?.n).toBe(0);
  });

  it('deletes pending and failed jobs of the removed effects only', async () => {
    expect((await run(sql`select id from outbox order by id`)).map((r) => Number(r.id))).toEqual([3, 5]);
  });

  it('drops the tracking tables', async () => {
    for (const t of ['environment_deploys', 'glob_environments', 'atf_batches']) expect(await tableExists(t)).toBe(false);
  });
});
