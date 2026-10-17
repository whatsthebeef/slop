import type {
  GetLogEventsCommand,
  GetLogEventsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';
import { describe, expect, it } from 'vitest';
import {
  CloudWatchBuildLogReader,
  LOG_MAX_BYTES,
  LOG_MAX_LINES,
  LogAccessDenied,
  LogNotReady,
  tailOf,
} from '../src/build-logs.js';
import type { LogsClient } from '../src/build-logs.js';

describe('tailOf', () => {
  it('keeps the last 200 lines', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${String(i)}`);
    const out = tailOf(lines).split('\n');
    expect(out).toHaveLength(LOG_MAX_LINES);
    expect(out[0]).toBe('line 300');
    expect(out.at(-1)).toBe('line 499');
  });

  it('cuts from the front to fit 64 KB', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `${String(i)} ${'x'.repeat(1000)}`);
    const out = tailOf(lines);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(LOG_MAX_BYTES);
    expect(out.endsWith(`149 ${'x'.repeat(1000)}`)).toBe(true);
  });

  it('keeps the end of a single line longer than the bound', () => {
    const out = tailOf([`start ${'é'.repeat(LOG_MAX_BYTES)} end`]);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(LOG_MAX_BYTES);
    expect(out.endsWith(' end')).toBe(true);
    expect(out).not.toContain('�');
  });

  it('masks before cutting, so a block split by the cut is masked whole', () => {
    const lines = [
      '-----BEGIN PRIVATE KEY-----',
      ...Array.from({ length: 250 }, () => 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'),
      '-----END PRIVATE KEY-----',
      'done',
    ];
    const out = tailOf(lines, (t) =>
      t.replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[masked]'),
    );
    expect(out).toBe('[masked]\ndone');
  });
});

/** A CloudWatch Logs client that answers each GetLogEvents with the next of `pages` (or throws it), recording the requests. */
const stubClient = (pages: readonly (Partial<GetLogEventsCommandOutput> | Error)[]) => {
  const requests: GetLogEventsCommand['input'][] = [];
  const regions: string[] = [];
  const client: LogsClient = {
    send: (command) => {
      requests.push(command.input);
      const page = pages[requests.length - 1] ?? { events: [] };
      return page instanceof Error
        ? Promise.reject(page)
        : Promise.resolve({ $metadata: {}, ...page });
    },
  };
  const reader = new CloudWatchBuildLogReader((region) => (regions.push(region), client));
  return { reader, requests, regions };
};

const events = (from: number, to: number, text = (i: number) => `line ${String(i)}`) =>
  Array.from({ length: to - from }, (_, k) => ({
    message: `${text(from + k)}\n`,
    timestamp: from + k,
  }));

const named = (name: string): Error => Object.assign(new Error(name), { name });

describe('CloudWatchBuildLogReader.tail', () => {
  it("pages back from the stream's end until it has 200 lines, oldest first", async () => {
    const { reader, requests, regions } = stubClient([
      { events: events(350, 500), nextBackwardToken: 'b1' },
      { events: events(200, 350), nextBackwardToken: 'b2' },
      { events: events(0, 200), nextBackwardToken: 'b3' },
    ]);
    const out = (await reader.tail('eu-west-1', '/aws/codebuild/p', 's1')).split('\n');
    expect(out).toHaveLength(LOG_MAX_LINES);
    expect(out[0]).toBe('line 300');
    expect(out.at(-1)).toBe('line 499');
    expect(regions).toEqual(['eu-west-1']);
    expect(requests).toEqual([
      {
        logGroupName: '/aws/codebuild/p',
        logStreamName: 's1',
        startFromHead: false,
        limit: LOG_MAX_LINES,
        nextToken: undefined,
      },
      {
        logGroupName: '/aws/codebuild/p',
        logStreamName: 's1',
        startFromHead: false,
        limit: LOG_MAX_LINES,
        nextToken: 'b1',
      },
    ]);
  });

  it('stops at the start of the stream (the same token back) and keeps what there is', async () => {
    const { reader, requests } = stubClient([
      { events: events(10, 20), nextBackwardToken: 'b1' },
      { events: events(0, 10), nextBackwardToken: 'b1' },
    ]);
    const out = (await reader.tail('us-east-1', 'g', 's')).split('\n');
    expect(out).toEqual(events(0, 20).map((e) => e.message.trimEnd()));
    expect(requests).toHaveLength(2);
  });

  it('keeps the end within 64 KB and masks before cutting', async () => {
    const { reader } = stubClient([
      {
        events: events(0, 200, (i) => `${String(i)} ${'x'.repeat(1000)}`),
        nextBackwardToken: 'b1',
      },
    ]);
    const out = await reader.tail('us-east-1', 'g', 's', (text) =>
      text.replace(/x{1000}/g, 'y'.repeat(1000)),
    );
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(LOG_MAX_BYTES);
    expect(out.endsWith(`199 ${'y'.repeat(1000)}`)).toBe(true);
    expect(out).not.toContain('x');
  });

  it('maps access denied to no access, a missing stream or an empty one to not readable yet, and passes other errors on', async () => {
    await expect(
      stubClient([named('AccessDeniedException')]).reader.tail('us-east-1', 'g', 's'),
    ).rejects.toBeInstanceOf(LogAccessDenied);
    await expect(
      stubClient([named('AccessDenied')]).reader.tail('us-east-1', 'g', 's'),
    ).rejects.toThrow("slop's role may not read g (needs logs:GetLogEvents)");
    await expect(
      stubClient([named('ResourceNotFoundException')]).reader.tail('us-east-1', 'g', 's'),
    ).rejects.toBeInstanceOf(LogNotReady);
    await expect(
      stubClient([{ events: [], nextBackwardToken: 'b1' }]).reader.tail('us-east-1', 'g', 's'),
    ).rejects.toBeInstanceOf(LogNotReady);
    const other = stubClient([named('ThrottlingException')]).reader.tail('us-east-1', 'g', 's');
    await expect(other).rejects.toThrow('ThrottlingException');
    await expect(other).rejects.not.toBeInstanceOf(LogNotReady);
  });

  it('keeps one client per region', async () => {
    const { reader, regions } = stubClient([
      { events: events(0, 1) },
      { events: events(0, 1) },
      { events: events(0, 1) },
    ]);
    await reader.tail('us-east-1', 'g', 's');
    await reader.tail('us-east-1', 'g', 's');
    await reader.tail('eu-west-1', 'g', 's');
    expect(regions).toEqual(['us-east-1', 'eu-west-1']);
  });
});
