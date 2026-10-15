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

describe('images_to_remove', () => {
  const list = 'r/slop:new\\nr/slop:prev\\nr/slop:old1\\nr/slop:old2';
  const run = (keep: string) => {
    const r = spawnSync(
      'bash',
      ['-c', `. ${lib}; printf '${list}\\n' | images_to_remove ${keep}`],
      {
        env: { PATH: process.env.PATH ?? '' },
        encoding: 'utf8',
      },
    );
    return r.stdout.split('\n').filter(Boolean);
  };
  it('keeps the running and previous release and removes the rest', () =>
    expect(run('r/slop:new r/slop:prev')).toEqual(['r/slop:old1', 'r/slop:old2']));
  it('keeps an image a running container uses', () =>
    expect(run('r/slop:new r/slop:prev r/slop:old2')).toEqual(['r/slop:old1']));
  it('ignores an empty previous release', () =>
    expect(run('r/slop:new ""')).toEqual(['r/slop:prev', 'r/slop:old1', 'r/slop:old2']));
});

describe('has_enough_disk', () => {
  it('needs the image plus the margin', () => {
    expect(sh('has_enough_disk 2800 800 2048').code).toBe(1);
    expect(sh('has_enough_disk 2848 800 2048').code).toBe(0);
  });
  it('counts an unknown image size as 0', () =>
    expect(sh('has_enough_disk 2048 "" 2048').code).toBe(0));
  it('fails when free space is unknown', () =>
    expect(sh('has_enough_disk "" 0 2048').code).toBe(1));
});

describe('disk_full_message', () => {
  it('says how much is free and needed', () => {
    const r = spawnSync('bash', ['-c', `. ${lib}; disk_full_message 1024 3000`], {
      encoding: 'utf8',
    });
    expect(r.stdout).toBe(
      'instance disk full: 1 GB free, need 3 GB; prune images or grow the root volume\n',
    );
  });
});
