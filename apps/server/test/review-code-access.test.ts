import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostCodeAccess, parseGrep } from '../src/review-code-access.js';
import { FakeCodeHost } from './support/fake-codehost.js';

const repo = { owner: 'o', name: 'r', base: 'main' };

describe('parseGrep', () => {
  it('reads git grep rows and stops at the limit', () => {
    const out = 'FETCH_HEAD:src/a.ts:3:pay(x)\nFETCH_HEAD:src/b:b.ts:9:a: b\nnoise\nFETCH_HEAD:../evil:1:x\n';
    expect(parseGrep(out, 10)).toEqual([
      { path: 'src/a.ts', line: 3, text: 'pay(x)' },
      { path: 'src/b:b.ts', line: 9, text: 'a: b' },
    ]);
    expect(parseGrep(out, 1)).toHaveLength(1);
  });
});

describe('HostCodeAccess', () => {
  it('reads and lists through the host', async () => {
    const host = new FakeCodeHost();
    host.readFile = (_r, ref, path) => Promise.resolve(`${ref}:${path}`);
    host.listDir = () => Promise.resolve([{ name: 'a.ts', type: 'file' }]);
    const access = new HostCodeAccess(host, repo, 'refs/pull/7/merge');
    expect(await access.readFile('src/a.ts')).toBe('refs/pull/7/merge:src/a.ts');
    expect(await access.listDir('src')).toEqual([{ name: 'a.ts', type: 'file' }]);
    await access.dispose();
  });

  it('refuses an option-like pattern before any clone is made', async () => {
    let tokens = 0;
    const host = new FakeCodeHost();
    host.readToken = () => {
      tokens += 1;
      return Promise.resolve('t');
    };
    const access = new HostCodeAccess(host, repo, 'main');
    await expect(access.grep('--open-files-in-pager=sh', 5)).rejects.toThrow('Invalid search pattern');
    expect(tokens).toBe(0);
  });

  it('removes its temporary folder when the clone fails', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('slop-review-')));
    const host = new FakeCodeHost();
    host.readToken = () => Promise.reject(new Error('no token'));
    const access = new HostCodeAccess(host, repo, 'main');
    await expect(access.grep('x', 5)).rejects.toThrow('could not be cloned');
    await access.dispose();
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('slop-review-') && !before.has(n))).toEqual([]);
  });

  it('searches a fetched commit without checking it out, and deletes the clone on dispose', async () => {
    // A local repository stands in for GitHub.
    const origin = mkdtempSync(join(tmpdir(), 'slop-origin-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
    git('init', '--quiet', '-b', 'main');
    mkdirSync(join(origin, 'src'));
    writeFileSync(join(origin, 'src', 'checkout.ts'), 'const a = 1;\npay(total);\n');
    writeFileSync(join(origin, 'bin.dat'), Buffer.from([0, 1, 2, 112, 97, 121, 40]));
    git('add', '.');
    git('commit', '--quiet', '-m', 'init');

    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('slop-review-')));
    const access = new HostCodeAccess(new FakeCodeHost(), repo, 'main', origin);
    try {
      expect(await access.grep('pay\\(', 10)).toEqual([{ path: 'src/checkout.ts', line: 2, text: 'pay(total);' }]);
      expect(await access.grep('nothing-like-this', 10)).toEqual([]);
      await expect(access.grep('(', 10)).rejects.toThrow();
      const clones = readdirSync(tmpdir()).filter((n) => n.startsWith('slop-review-') && !before.has(n));
      expect(clones).toHaveLength(1);
      // Only searched: nothing is checked out.
      expect(existsSync(join(tmpdir(), clones[0] ?? '', 'src'))).toBe(false);
    } finally {
      await access.dispose();
      await access.dispose();
    }
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('slop-review-') && !before.has(n))).toEqual([]);
  });
});
