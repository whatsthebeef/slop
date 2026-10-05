import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileTokenStore, tokenFilePath } from '../src/token-store.js';

describe('FileTokenStore', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'slop-cli-home-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const tokens = { access_token: 'a', refresh_token: 'r', expires_at: 100 };

  it('keeps one login per slop URL in a 0600 file under the home directory', async () => {
    const store = new FileTokenStore(tokenFilePath(home));
    expect(store.path).toBe(join(home, '.config', 'slop', 'tokens.json'));
    await store.save('https://one.test', tokens);
    await store.save('https://two.test', { ...tokens, access_token: 'b' });

    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(await store.load('https://one.test')).toEqual(tokens);
    expect((await store.load('https://two.test'))?.access_token).toBe('b');

    await store.delete('https://one.test');
    expect(await store.load('https://one.test')).toBeUndefined();
    expect((await store.load('https://two.test'))?.access_token).toBe('b');
  });

  it('tightens an existing file to 0600 when it saves', async () => {
    const path = tokenFilePath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{}', { mode: 0o644 });
    await new FileTokenStore(path).save('https://one.test', tokens);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('reads a missing or damaged file as no login', async () => {
    const path = tokenFilePath(home);
    const store = new FileTokenStore(path);
    expect(await store.load('https://one.test')).toBeUndefined();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not json');
    expect(await store.load('https://one.test')).toBeUndefined();
    await writeFile(path, JSON.stringify({ 'https://one.test': { access_token: 1 } }));
    expect(await store.load('https://one.test')).toBeUndefined();
  });
});
