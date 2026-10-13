import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/http/app.js';
import { buildSkillZip, mountSkillZip } from '../src/http/skill-zip.js';
import { curlFor } from '../src/upload-instructions.js';

const SKILLS = new URL('../../../skills', import.meta.url).pathname;
const SCRIPT = join(SKILLS, 'slop-attach/scripts/upload.sh');

/** Entries of a zip, read from its central directory. */
const entries = (zip: Buffer) => {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: { name: string; mode: number; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const size = zip.readUInt32LE(at + 20);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString();
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const method = zip.readUInt16LE(at + 10);
    const raw = zip.subarray(start, start + size);
    out.push({ name, mode: (zip.readUInt32LE(at + 38) >>> 16) & 0o777, data: method === 0 ? raw : inflateRawSync(raw) });
    at += 46 + nameLength;
  }
  return out;
};

describe('slop-attach skill zip', () => {
  it('holds the skill folder with the script executable and the files byte for byte', () => {
    const files = entries(buildSkillZip(SKILLS));
    expect(files.map((f) => f.name)).toEqual(['slop-attach/SKILL.md', 'slop-attach/scripts/upload.sh']);
    expect((files.find((f) => f.name.endsWith('upload.sh'))?.mode ?? 0) & 0o111).not.toBe(0);
    expect(files[0]?.data.toString()).toBe(readFileSync(join(SKILLS, 'slop-attach/SKILL.md'), 'utf8'));
    expect(files[0]?.data.toString()).toMatch(/^---\nname: slop-attach\n/);
  });

  it('is a zip that unzip accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skillzip-'));
    try {
      writeFileSync(join(dir, 'a.zip'), buildSkillZip(SKILLS));
      const listed = spawnSync('unzip', ['-l', join(dir, 'a.zip')], { encoding: 'utf8' });
      if (listed.error === undefined) expect(listed.stdout).toContain('slop-attach/scripts/upload.sh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is served to board members only, with install steps naming the bucket host', async () => {
    const app = new Hono<Env>();
    app.use('*', async (c, next) => {
      c.set('email', c.req.header('x-email') ?? '');
      await next();
    });
    const boards = {
      get: (email: string) => Promise.resolve(email === 'dev@example.com' ? { ok: true as const, value: {} as never } : { ok: false as const, error: { code: 'forbidden' as const, message: 'no' } }),
    };
    mountSkillZip(app, { boards, skillsDir: SKILLS, uploadHost: 'b.s3.us-east-1.amazonaws.com' });
    const zip = await app.request('/api/boards/1/skills/slop-attach.zip', { headers: { 'x-email': 'dev@example.com' } });
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(entries(Buffer.from(await zip.arrayBuffer()))).toHaveLength(2);
    expect((await app.request('/api/boards/1/skills/slop-attach.zip', { headers: { 'x-email': 'x@example.com' } })).status).toBe(403);
    const info = (await (await app.request('/api/boards/1/skills/slop-attach', { headers: { 'x-email': 'dev@example.com' } })).json()) as { install: string[] };
    expect(info.install.join(' ')).toContain('b.s3.us-east-1.amazonaws.com');
  });
});

describe('slop-attach upload.sh', () => {
  let dir: string;
  let seen: { body: string; contentType: string }[];
  let status = 204;
  let server: ReturnType<typeof createServer>;
  let url: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'upload-sh-'));
    seen = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ body: Buffer.concat(chunks).toString('latin1'), contentType: req.headers['content-type'] ?? '' });
        res.statusCode = status;
        res.end(status >= 400 ? '<Error><Code>EntityTooLarge</Code><Message>Your proposed upload exceeds the maximum allowed size</Message></Error>' : '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Async: the stub server lives in this process, so a blocking spawn would never get its answer.
  const upload = (path: string, json: string) =>
    new Promise<{ status: number; stdout: string }>((resolve) => {
      execFile('sh', [SCRIPT, path, json], { encoding: 'utf8' }, (error, stdout) => resolve({ status: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout }));
    });
  const fields = { key: 'boards/1/globs/s1t1/u1', 'Content-Type': 'image/png', policy: 'cG9saWN5', 'x-amz-signature': 'abc' };

  it('posts every field before the file as multipart and says it uploaded', async () => {
    const file = join(dir, 'shot 1.png');
    writeFileSync(file, 'PNGDATA');
    seen.length = 0;
    status = 204;
    const result = await upload(file, JSON.stringify({ url, fields }));
    expect(result.stdout.trim()).toBe('uploaded shot 1.png');
    expect(result.status).toBe(0);
    const [request] = seen;
    expect(request?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    for (const [name, value] of Object.entries(fields)) expect(request?.body).toContain(`name="${name}"\r\n\r\n${value}\r\n`);
    expect(request?.body).toContain('name="file"; filename="shot 1.png"');
    expect(request?.body).toContain('PNGDATA');
    // The file part is last, as S3 requires.
    expect(request?.body.indexOf('name="file"')).toBeGreaterThan(request?.body.indexOf('name="x-amz-signature"') ?? 0);
  });

  it('reports a refusal in one line with the reason', async () => {
    const file = join(dir, 'big.png');
    writeFileSync(file, 'x');
    status = 400;
    const result = await upload(file, JSON.stringify({ url, fields }));
    expect(result.status).toBe(1);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout).toMatch(/^failed: big\.png: upload refused \(HTTP 400: Your proposed upload exceeds/);
  });

  it('names the network setting when the host cannot be reached, and rejects bad input', async () => {
    const file = join(dir, 'a.png');
    writeFileSync(file, 'x');
    const unreachable = await upload(file, JSON.stringify({ url: 'http://127.0.0.1:1/', fields }));
    expect(unreachable.status).toBe(1);
    expect(unreachable.stdout).toContain('Code execution');
    expect((await upload(file, 'not json')).stdout).toContain('upload json is not valid');
    expect((await upload(join(dir, 'missing.png'), JSON.stringify({ url, fields }))).stdout).toContain('is not a file');
  });
});

describe('curlFor', () => {
  it('quotes values and puts the file last', () => {
    const curl = curlFor({ url: 'https://b.s3.example.com/', fields: { key: "k'1", policy: 'p' } });
    expect(curl).toBe(`curl -sS -f -X POST -F 'key=k'\\''1' -F 'policy=p' -F file=@<path> 'https://b.s3.example.com/'`);
    // The command is valid shell: the quoting survives a round trip.
    expect(execFileSync('sh', ['-c', `set -- ${curl.replace('curl -sS -f -X POST', '').replace('<path>', 'f')}; printf '%s\\n' "$@"`], { encoding: 'utf8' })).toContain("key=k'1");
  });
});
