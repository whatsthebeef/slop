import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const lib = join(__dirname, '../deploy/deploy-guards.sh');

function sh(script: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `. ${lib}; ${script}`], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr };
}

describe('is_superseded', () => {
  it('skips a build whose commit is no longer the head of main', () =>
    expect(sh('is_superseded aaa bbb').code).toBe(0));
  it('deploys the head', () => expect(sh('is_superseded aaa aaa').code).toBe(1));
  it('deploys when the head could not be read', () =>
    expect(sh('is_superseded aaa ""').code).toBe(1));
});

describe('is_older_than_running', () => {
  it('refuses an older commit', () => expect(sh('is_older_than_running 100 200').code).toBe(0));
  it('allows a newer or equal commit', () => {
    expect(sh('is_older_than_running 300 200').code).toBe(1);
    expect(sh('is_older_than_running 200 200').code).toBe(1);
  });
  it('allows a deploy when a time is unknown', () => {
    expect(sh('is_older_than_running "" 200').code).toBe(1);
    expect(sh('is_older_than_running 100 ""').code).toBe(1);
  });
});

describe('data_disk_guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-disk-'));
  const skip = { SLOP_SKIP_MOUNT_CHECK: '1' };

  it('fails when the directory is not a mount point', () => {
    const r = sh(`data_disk_guard ${dir}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain('data disk not mounted');
  });
  it('fails on an empty disk', () => {
    const r = sh(`data_disk_guard ${dir}`, skip);
    expect(r.code).toBe(1);
    expect(r.err).toContain('data disk has no database');
  });
  it('allows an empty disk for a first deploy', () =>
    expect(sh(`data_disk_guard ${dir}`, { ...skip, SLOP_FIRST_DEPLOY: '1' }).code).toBe(0));
  it('still requires the mount for a first deploy', () =>
    expect(sh(`data_disk_guard ${dir}`, { SLOP_FIRST_DEPLOY: '1' }).code).toBe(1));
  it('passes with a cluster and password', () => {
    mkdirSync(join(dir, 'postgres'));
    writeFileSync(join(dir, 'postgres/PG_VERSION'), '16\n');
    writeFileSync(join(dir, 'postgres-password'), 'x\n');
    expect(sh(`data_disk_guard ${dir}`, skip).code).toBe(0);
  });
});
