import { execFile, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const run = promisify(execFile);
const scripts = new URL('../../../catalog/scripts/', import.meta.url).pathname;
const has = (command: string): boolean =>
  spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;

const JUNIT = `<?xml version="1.0"?>
<testsuites name="" tests="5" failures="1" skipped="1">
  <testsuite name="board.spec.ts" tests="2">
    <testcase name="loads" classname="board.spec.ts" time="1.5"/>
    <testcase name="lists globs" classname="board.spec.ts" time="0.5"/>
  </testsuite>
  <testsuite name="merge.spec.ts" tests="2">
    <testcase name="confirms" classname="[chromium] › merge.spec.ts" time="2"><failure message="boom"/></testcase>
    <testcase name="cancels" classname="[chromium] › merge.spec.ts" time="1"/>
  </testsuite>
  <testsuite name="other.spec.ts" tests="1">
    <testcase name="later" classname="other.spec.ts"><skipped/></testcase>
  </testsuite>
</testsuites>
`;

const eventSchema = z.array(
  z.object({
    Source: z.literal('slop.ci'),
    DetailType: z.literal('Slop ATF Completed'),
    Detail: z.string(),
  }),
);
const detailSchema = z.object({
  repo: z.string(),
  environment: z.string(),
  sha: z.string(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  specs: z
    .array(
      z.object({
        file: z.string(),
        status: z.string(),
        tests: z.number(),
        failed: z.number(),
        durationMs: z.number().optional(),
      }),
    )
    .optional(),
});

describe.skipIf(!has('python3') || !has('bash'))('atf-report.sh', () => {
  let dir: string;
  let bin: string;
  let capture: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'atf-report-'));
    bin = join(dir, 'bin');
    capture = join(dir, 'entries.json');
    mkdirSync(bin);
    // A stand-in for the AWS CLI: keeps the entries file it was given and reports no failed entries.
    writeFileSync(
      join(bin, 'aws'),
      '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--entries" ]; then cp "${2#file://}" "$CAPTURE"; fi; shift; done\necho 0\n',
    );
    chmodSync(join(bin, 'aws'), 0o755);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const report = async (reports: string, extra: Record<string, string> = {}) => {
    rmSync(capture, { force: true });
    const result = await run('bash', [join(scripts, 'atf-report.sh'), 'staging', reports], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CAPTURE: capture,
        SLOP_REPO: 'acme/app',
        SLOP_SHA: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
        ...extra,
      },
    });
    return result;
  };

  it('reports per-spec rows grouped by file, under the planned path, with missing ones, failures first', async () => {
    const reports = join(dir, 'with-reports');
    mkdirSync(reports);
    writeFileSync(join(reports, 'results.xml'), JUNIT);
    await report(reports, {
      SLOP_ATF_SPECS: 'e2e/board.spec.ts\ne2e/gone.spec.ts\ne2e/merge.spec.ts\n',
    });
    const [event] = eventSchema.parse(JSON.parse(readFileSync(capture, 'utf8')));
    const detail = detailSchema.parse(JSON.parse(event?.Detail ?? '{}'));
    expect(detail).toMatchObject({
      repo: 'acme/app',
      environment: 'staging',
      passed: 3,
      failed: 1,
      skipped: 1,
    });
    expect(detail.specs).toEqual([
      { file: 'e2e/merge.spec.ts', status: 'failed', tests: 2, failed: 1, durationMs: 3000 },
      { file: 'e2e/gone.spec.ts', status: 'missing', tests: 0, failed: 0 },
      { file: 'other.spec.ts', status: 'skipped', tests: 1, failed: 0, durationMs: 0 },
      { file: 'e2e/board.spec.ts', status: 'passed', tests: 2, failed: 0, durationMs: 2000 },
    ]);
  });

  it('reports the files as the report names them when nothing is planned, and reads the planned list from specs.json', async () => {
    const reports = join(dir, 'plain');
    mkdirSync(reports);
    writeFileSync(join(reports, 'results.xml'), JUNIT);
    await report(reports);
    const first = detailSchema.parse(
      JSON.parse(eventSchema.parse(JSON.parse(readFileSync(capture, 'utf8')))[0]?.Detail ?? '{}'),
    );
    expect(first.specs?.map((s) => [s.file, s.status])).toEqual([
      ['merge.spec.ts', 'failed'],
      ['other.spec.ts', 'skipped'],
      ['board.spec.ts', 'passed'],
    ]);
    writeFileSync(
      join(reports, 'specs.json'),
      JSON.stringify({ status: 'ready', specs: [{ spec: 'e2e/never.spec.ts', globs: ['s1t1'] }] }),
    );
    await report(reports);
    const second = detailSchema.parse(
      JSON.parse(eventSchema.parse(JSON.parse(readFileSync(capture, 'utf8')))[0]?.Detail ?? '{}'),
    );
    expect(second.specs?.map((s) => [s.file, s.status])).toContainEqual([
      'e2e/never.spec.ts',
      'missing',
    ]);
  });

  it('warns and exits 0 without reports, and reports nothing', async () => {
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    const result = await report(empty);
    expect(result.stderr).toContain('no JUnit reports');
    expect(existsSync(capture)).toBe(false);
  });

  it('skips unreadable XML with a warning and still exits 0', async () => {
    const reports = join(dir, 'broken');
    mkdirSync(reports);
    writeFileSync(join(reports, 'results.xml'), JUNIT);
    writeFileSync(join(reports, 'bad.xml'), '<testsuite><oops');
    const result = await report(reports);
    expect(result.stderr).toContain('skipping');
    expect(existsSync(capture)).toBe(true);
  });
});

describe.skipIf(!has('python3') || !has('bash') || !has('curl'))('atf-specs.sh', () => {
  let server: Server;
  let url: string;
  let dir: string;
  const seen: { path: string; auth: string | undefined }[] = [];
  let mode: 'ready' | 'pending-then-ready' | 'superseded' | 'down' = 'ready';
  let hits = 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atf-specs-'));
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization });
      hits += 1;
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (mode === 'superseded') {
        send(409, { status: 'superseded', latestSha: 'b'.repeat(40) });
        return;
      }
      if (mode === 'down') {
        send(500, { code: 'boom' });
        return;
      }
      if (mode === 'pending-then-ready' && hits === 1) {
        send(202, { status: 'pending', retryAfterSeconds: 1 });
        return;
      }
      send(200, {
        status: 'ready',
        environment: 'staging',
        sha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
        specs: [
          { spec: 'e2e/a.spec.ts', globs: ['s1t1'] },
          { spec: 'e2e/b.spec.ts', globs: ['s1t1', 's1t2'] },
        ],
        greps: [
          { grep: '@smoke', globs: ['s1t2'] },
          { grep: '@rollout', globs: ['s1t1'] },
        ],
        batchId: 1,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('the test server has no port');
    url = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  /** Sources the script as a build would and prints what it exported, as JSON. */
  const source = async (extra: Record<string, string> = {}) => {
    seen.length = 0;
    hits = 0;
    const reports = join(dir, `r${String(Math.random()).slice(2)}`);
    const { stdout } = await run(
      'bash',
      [
        '-c',
        `. "${join(scripts, 'atf-specs.sh')}" staging "${reports}"; printf '@@\\n%s\\n---\\n%s' "$SLOP_ATF_SPECS" "$SLOP_ATF_GREP"`,
      ],
      {
        env: {
          PATH: process.env.PATH ?? '',
          SLOP_URL: url,
          SLOP_BOARD: '4',
          SLOP_TOKEN: 'slopit_secret',
          SLOP_SHA: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
          SLOP_ATF_POLL_SECONDS: '1',
          ...extra,
        },
      },
    );
    const [specs = '', grep = ''] = (stdout.split('@@\n')[1] ?? '').split('\n---\n');
    return { specs: specs.split('\n').filter((s) => s !== ''), grep: grep.trim(), reports };
  };

  it('asks with the board token and exports the specs and the combined grep, keeping the answer beside the reports', async () => {
    mode = 'ready';
    const out = await source();
    expect(out.specs).toEqual(['e2e/a.spec.ts', 'e2e/b.spec.ts']);
    expect(out.grep).toBe('(?:@smoke)|(?:@rollout)');
    expect(seen).toEqual([
      {
        path: '/integrations/boards/4/atf-specs?environment=staging&sha=a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
        auth: 'Bearer slopit_secret',
      },
    ]);
    expect(existsSync(join(out.reports, 'specs.json'))).toBe(true);
  });

  it('waits while slop is still checking the deploy', async () => {
    mode = 'pending-then-ready';
    const out = await source();
    expect(hits).toBe(2);
    expect(out.specs).toEqual(['e2e/a.spec.ts', 'e2e/b.spec.ts']);
  });

  it('runs the default suite (empty list, exit 0) when superseded, on a server error, or when it cannot reach slop', async () => {
    mode = 'superseded';
    expect((await source()).specs).toEqual([]);
    mode = 'down';
    expect((await source()).specs).toEqual([]);
    expect((await source({ SLOP_URL: 'http://127.0.0.1:9' })).specs).toEqual([]);
  });

  it('warns and asks for nothing without its settings, or when the list came with the build', async () => {
    mode = 'ready';
    expect((await source({ SLOP_TOKEN: '' })).specs).toEqual([]);
    expect(seen).toEqual([]);
    const preset = await source({ SLOP_ATF_SPECS: 'e2e/pushed.spec.ts' });
    expect(preset.specs).toEqual(['e2e/pushed.spec.ts']);
    expect(seen).toEqual([]);
    expect((await source({ SLOP_ATF_SPECS: '' })).specs).toEqual([]);
    expect(seen).toEqual([]);
  });
});

/** Which identity the catalog scripts choose from the environment, and how they post to slop. */
describe.skipIf(!has('python3') || !has('bash') || !has('curl'))('ATF runner identity in the scripts', () => {
  interface Seen {
    method: string;
    path: string;
    auth: string | undefined;
    key: string | undefined;
    body: string;
  }
  let server: Server;
  let url: string;
  let dir: string;
  let bin: string;
  let awsLog: string;
  let events: string;
  const seen: Seen[] = [];
  let status = 201;
  let tokenStatus = 200;
  let curlLog: string;
  const CLIENT_JWT = 'client.access.token';
  const CLIENT_SECRET = 'shh-very-secret-value';
  const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
  const AWS_JWT = 'header.payload.signature-from-aws';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atf-identity-'));
    bin = join(dir, 'bin');
    awsLog = join(dir, 'aws.log');
    events = join(dir, 'events.json');
    mkdirSync(bin);
    // A curl that logs its arguments (to prove no secret is among them) and then runs the real one.
    curlLog = join(dir, 'curl.log');
    const realCurl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\necho "$*" >> "$CURL_LOG"\nexec "${realCurl}" "$@"\n`);
    chmodSync(join(bin, 'curl'), 0o755);
    // A stand-in AWS CLI: `sts get-web-identity-token` logs its arguments and prints a JWT; put-events keeps the entries.
    writeFileSync(
      join(bin, 'aws'),
      `#!/bin/sh
if [ "$1" = "sts" ] && [ "$2" = "get-web-identity-token" ]; then echo "$*" >> "$AWS_LOG"; echo "${AWS_JWT}"; exit 0; fi
while [ $# -gt 0 ]; do if [ "$1" = "--entries" ]; then cp "\${2#file://}" "$EVENTS"; fi; shift; done
echo 0
`,
    );
    chmodSync(join(bin, 'aws'), 0o755);
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          path: req.url ?? '',
          auth: req.headers.authorization,
          key: req.headers['idempotency-key'] as string | undefined,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (req.url === '/oauth2/token') {
          res.writeHead(tokenStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify(tokenStatus === 200 ? { access_token: CLIENT_JWT, expires_in: 3600 } : { error: 'invalid_client' }));
          return;
        }
        const ok = status === 200 || status === 201;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            req.url?.includes('atf-specs') === true && ok
              ? { status: 'ready', specs: [{ spec: 'e2e/a.spec.ts', globs: ['s1t1'] }], greps: [] }
              : { status: 'recorded' },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('the test server has no port');
    url = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const base = (): Record<string, string> => ({
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    AWS_LOG: awsLog,
    CURL_LOG: curlLog,
    EVENTS: events,
    SLOP_URL: url,
    SLOP_BOARD: '4',
    SLOP_SHA: SHA,
    SLOP_REPO: 'acme/app',
  });

  const reports = (name: string): string => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'results.xml'), JUNIT);
    return path;
  };

  const report = async (name: string, extra: Record<string, string>) => {
    seen.length = 0;
    rmSync(events, { force: true });
    rmSync(awsLog, { force: true });
    rmSync(curlLog, { force: true });
    return run('bash', [join(scripts, 'atf-report.sh'), 'staging', reports(name)], {
      env: { ...base(), ...extra },
    });
  };
  const specs = async (extra: Record<string, string>) => {
    seen.length = 0;
    rmSync(awsLog, { force: true });
    rmSync(curlLog, { force: true });
    const out = join(dir, `s${String(Math.random()).slice(2)}`);
    const { stdout, stderr } = await run(
      'bash',
      [
        '-c',
        `. "${join(scripts, 'atf-specs.sh')}" staging "${out}"; printf '@@%s' "$SLOP_ATF_SPECS"`,
      ],
      { env: { ...base(), SLOP_ATF_POLL_SECONDS: '1', ...extra } },
    );
    return { specs: (stdout.split('@@')[1] ?? '').split('\n').filter((l) => l !== ''), stderr };
  };

  it('posts results over HTTP with the OIDC token, a per-run Idempotency-Key, and the per-spec rows', async () => {
    status = 201;
    const out = await report('oidc', {
      SLOP_OIDC_TOKEN: 'oidc.jwt.value',
      SLOP_TOKEN: 'slopit_board',
      SLOP_ATF_IDEMPOTENCY_KEY: 'run-77',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/integrations/boards/4/atf-results',
      auth: 'Bearer oidc.jwt.value',
      key: 'run-77',
    });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({
      environment: 'staging',
      sha: SHA,
      passed: 3,
      failed: 1,
      skipped: 1,
    });
    expect(existsSync(events)).toBe(false);
    expect(out.stdout + out.stderr).not.toContain('oidc.jwt.value');
  });

  it('takes the key from the CodeBuild build id, and makes a distinct one when there is no run id', async () => {
    await report('key1', { SLOP_TOKEN: 'slopit_board', CODEBUILD_BUILD_ID: 'proj:build-1' });
    expect(seen[0]?.key).toBe('proj:build-1');
    await report('key2', { SLOP_TOKEN: 'slopit_board', GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '2' });
    expect(seen[0]?.key).toBe('gha-99-2');
    await report('key3', { SLOP_TOKEN: 'slopit_board' });
    const first = seen[0]?.key;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await report('key4', { SLOP_TOKEN: 'slopit_board' });
    expect(first).toBeTruthy();
    expect(seen[0]?.key).not.toBe(first);
  });

  it('uses the AWS identity when AWS credentials are set and there is no SLOP_TOKEN, with slop as the audience', async () => {
    const out = await report('aws', { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', CODEBUILD_BUILD_ID: 'p:1' });
    expect(seen[0]?.auth).toBe(`Bearer ${AWS_JWT}`);
    expect(readFileSync(awsLog, 'utf8')).toContain(`--audience ${url}`);
    expect(out.stdout + out.stderr).not.toContain(AWS_JWT);
  });

  it('falls back to the board token, and prefers a CI token over everything', async () => {
    await report('token', { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', SLOP_TOKEN: 'slopit_board' });
    expect(seen[0]?.auth).toBe('Bearer slopit_board');
    expect(existsSync(awsLog)).toBe(false);
    await report('both', { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', SLOP_OIDC_TOKEN: 'ci.jwt' });
    expect(seen[0]?.auth).toBe('Bearer ci.jwt');
    await report('forced', { SLOP_TOKEN: 'slopit_board', SLOP_OIDC_TOKEN: 'ci.jwt', SLOP_ATF_AUTH: 'token' });
    expect(seen[0]?.auth).toBe('Bearer slopit_board');
  });

  it('keeps EventBridge when it is selected, or when there is no identity for HTTP', async () => {
    await report('eb', { SLOP_OIDC_TOKEN: 'ci.jwt', SLOP_ATF_TRANSPORT: 'eventbridge' });
    expect(seen).toHaveLength(0);
    expect(existsSync(events)).toBe(true);
    await report('noid', {});
    expect(seen).toHaveLength(0);
    expect(existsSync(events)).toBe(true);
  });

  it('never fails the pipeline: a refusal, a server error or an unreachable slop is a warning with exit 0', async () => {
    status = 401;
    const refused = await report('refused', { SLOP_OIDC_TOKEN: 'ci.jwt' });
    expect(refused.stderr).toContain('slop didn');
    expect(refused.stderr).not.toContain('ci.jwt');
    status = 500;
    expect((await report('boom', { SLOP_OIDC_TOKEN: 'ci.jwt' })).stderr).toContain('500');
    status = 201;
    expect((await report('down', { SLOP_OIDC_TOKEN: 'ci.jwt', SLOP_URL: 'http://127.0.0.1:9' })).stderr).toContain('000');
  });

  it('asks for the specs with the OIDC token, the AWS identity or the board token, in that order', async () => {
    status = 200;
    const viaOidc = await specs({ SLOP_OIDC_TOKEN: 'ci.jwt', SLOP_TOKEN: 'slopit_board' });
    expect(viaOidc.specs).toEqual(['e2e/a.spec.ts']);
    expect(seen[0]?.auth).toBe('Bearer ci.jwt');
    await specs({ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE' });
    expect(seen[0]?.auth).toBe(`Bearer ${AWS_JWT}`);
    expect(readFileSync(awsLog, 'utf8')).toContain('--signing-algorithm RS256');
    await specs({ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', SLOP_TOKEN: 'slopit_board' });
    expect(seen[0]?.auth).toBe('Bearer slopit_board');
  });

  it('runs the default suite, exit 0, with no identity or a refused one, and never prints the token', async () => {
    status = 200;
    expect((await specs({})).specs).toEqual([]);
    expect(seen).toHaveLength(0);
    status = 401;
    const refused = await specs({ SLOP_OIDC_TOKEN: 'ci.jwt' });
    expect(refused.specs).toEqual([]);
    expect(refused.stderr).toContain('oidc identity');
    expect(refused.stderr).not.toContain('ci.jwt');
  });

  const client = (): Record<string, string> => ({
    SLOP_CLIENT_ID: 'client-id-1',
    SLOP_CLIENT_SECRET: CLIENT_SECRET,
    SLOP_TOKEN_URL: `${url}/oauth2/token`,
  });
  const basic = `Basic ${Buffer.from(`client-id-1:${CLIENT_SECRET}`).toString('base64')}`;

  it('exchanges client credentials for a token (write scope) and reports with it, the secret never on a command line or in the output', async () => {
    status = 201;
    tokenStatus = 200;
    const out = await report('client', { ...client(), CODEBUILD_BUILD_ID: 'p:2' });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/oauth2/token', auth: basic });
    const form = new URLSearchParams(seen[0]?.body ?? '');
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe('slop/atf.write-results');
    expect(seen[1]).toMatchObject({ path: '/integrations/boards/4/atf-results', auth: `Bearer ${CLIENT_JWT}` });
    expect(readFileSync(curlLog, 'utf8')).not.toContain(CLIENT_SECRET);
    for (const text of [out.stdout, out.stderr]) {
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain(CLIENT_JWT);
    }
  });

  it('asks for the specs with the read scope and the client token, and lets SLOP_ATF_SCOPE override it', async () => {
    status = 200;
    tokenStatus = 200;
    const got = await specs(client());
    expect(got.specs).toEqual(['e2e/a.spec.ts']);
    expect(new URLSearchParams(seen[0]?.body ?? '').get('scope')).toBe('slop/atf.read-specs');
    expect(seen[1]?.auth).toBe(`Bearer ${CLIENT_JWT}`);
    expect(readFileSync(curlLog, 'utf8')).not.toContain(CLIENT_SECRET);
    await specs({ ...client(), SLOP_ATF_SCOPE: 'slop/atf.write-results' });
    expect(new URLSearchParams(seen[0]?.body ?? '').get('scope')).toBe('slop/atf.write-results');
  });

  it('puts the client identity after a CI token and before AWS and the board token, and SLOP_ATF_AUTH forces one', async () => {
    status = 200;
    tokenStatus = 200;
    await specs({ ...client(), SLOP_OIDC_TOKEN: 'ci.jwt' });
    expect(seen.map((r) => r.path)).toEqual([expect.stringContaining('atf-specs')]);
    expect(seen[0]?.auth).toBe('Bearer ci.jwt');
    await specs({ ...client(), SLOP_TOKEN: 'slopit_board', AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE' });
    expect(seen[1]?.auth).toBe(`Bearer ${CLIENT_JWT}`);
    expect(existsSync(awsLog)).toBe(false);
    await specs({ ...client(), SLOP_TOKEN: 'slopit_board', SLOP_ATF_AUTH: 'token' });
    expect(seen.map((r) => r.auth)).toEqual(['Bearer slopit_board']);
  });

  it('warns and exits 0 when the token request is refused or the client settings are incomplete, naming no secret', async () => {
    status = 201;
    tokenStatus = 401;
    const refused = await report('client-refused', client());
    // Without a usable identity the report takes the EventBridge route, as for any missing identity.
    expect(existsSync(events)).toBe(true);
    expect(refused.stdout + refused.stderr).not.toContain(CLIENT_SECRET);
    expect(seen.map((r) => r.path)).toEqual(['/oauth2/token']);
    status = 200;
    const none = await specs(client());
    expect(none.specs).toEqual([]);
    expect(none.stderr).not.toContain(CLIENT_SECRET);
    tokenStatus = 200;
    const incomplete = await specs({ ...client(), SLOP_TOKEN_URL: '' });
    expect(incomplete.specs).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it.each(['atf-specs.sh', 'atf-report.sh', 'buildspec-atf.yml', 'github-actions-atf.yml', 'README.md'])(
    '%s exists beside the others; the shell scripts parse',
    (file) => {
      expect(existsSync(join(scripts, file))).toBe(true);
      if (file.endsWith('.sh')) expect(spawnSync('bash', ['-n', join(scripts, file)]).status).toBe(0);
    },
  );

  it.skipIf(!has('shellcheck'))('passes shellcheck at error level', () => {
    const result = spawnSync(
      'shellcheck',
      ['-S', 'error', join(scripts, 'atf-specs.sh'), join(scripts, 'atf-report.sh')],
      { encoding: 'utf8' },
    );
    expect(result.stdout + result.stderr).toBe('');
  });

  it('the buildspec and the example workflow keep slop secrets out and the workflow outside .github/workflows', () => {
    const buildspec = readFileSync(join(scripts, 'buildspec-atf.yml'), 'utf8');
    expect(buildspec).toContain('get-web-identity-token');
    expect(buildspec).not.toMatch(/^\s+SLOP_TOKEN\s*:/m);
    const workflow = readFileSync(join(scripts, 'github-actions-atf.yml'), 'utf8');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('SLOP_OIDC_TOKEN');
    expect(workflow).not.toContain('secrets.');
  });
});

describe('catalog/scripts/step-template.sh', () => {
  const template = join(scripts, 'step-template.sh');

  it('parses with bash -n and prints its header for --help', () => {
    expect(spawnSync('bash', ['-n', template]).status).toBe(0);
    const help = spawnSync('bash', [template, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Permissions and login it needs');
    expect(help.stdout).toContain('--dry-run');
  });

  it('rejects an unknown argument without changing anything', () => {
    const result = spawnSync('bash', [template, '--nope'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument');
  });

  it.skipIf(!has('shellcheck'))('passes shellcheck', () => {
    const result = spawnSync('shellcheck', [template], { encoding: 'utf8' });
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('has the shape a step script needs: preflight, summary, confirmation, final check', () => {
    const text = readFileSync(template, 'utf8');
    for (const part of ['preflight()', 'summary()', 'apply()', 'verify()', '--yes', '--dry-run', 'Go ahead? [y/N]']) expect(text).toContain(part);
  });
});
