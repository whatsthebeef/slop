import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/http/app.js';
import { mountWeb } from '../src/http/web.js';

describe('web app serving', () => {
  let root: string;
  let app: Hono<Env>;
  const page = (script: string) =>
    `<!doctype html><script type="module" src="/assets/${script}"></script>`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'slop-web-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), page('a.js'));
    await writeFile(join(root, 'assets', 'a.js'), 'console.log(1)');
    app = new Hono<Env>();
    mountWeb(app, root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('gives app routes the app page, and picks up a rebuilt index.html', async () => {
    expect(await (await app.request('/boards/1')).text()).toContain('a.js');
    await writeFile(join(root, 'index.html'), page('b.js'));
    const later = new Date(Date.now() + 5000);
    await utimes(join(root, 'index.html'), later, later);
    expect(await (await app.request('/boards/1')).text()).toContain('b.js');
  });

  it('serves built files', async () => {
    expect(await (await app.request('/assets/a.js')).text()).toBe('console.log(1)');
  });

  it('404s a missing asset instead of answering with HTML', async () => {
    const response = await app.request('/assets/missing.js');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
    expect((await app.request('/favicon.ico')).status).toBe(404);
  });
});
