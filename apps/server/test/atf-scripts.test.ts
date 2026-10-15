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
