import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

/** The most lines, and bytes, of a build log's end that slop keeps on a glob. */
export const LOG_MAX_LINES = 200;
export const LOG_MAX_BYTES = 64 * 1024;

/** slop's role may not read the build's log group (the host stack's grant is missing); retrying won't help. */
export class LogAccessDenied extends Error {}

/** The stream isn't readable yet (CodeBuild creates it a moment after the build ends) or holds nothing; a retry may succeed. */
export class LogNotReady extends Error {}

/** Reads the end of a finished build's log. */
export interface BuildLogReader {
  /** `mask` runs over the whole text before it is cut, so a secret split by the cut can't survive. */
  tail(region: string, group: string, stream: string, mask?: (text: string) => string): Promise<string>;
}

/** The last `LOG_MAX_LINES` lines of `lines`, cut again from the front to fit `LOG_MAX_BYTES`. */
export const tailOf = (lines: readonly string[], mask: (text: string) => string = (text) => text): string => {
  // Masked first: a PEM block whose BEGIN line falls outside the cut would otherwise keep its body.
  let kept = mask(lines.join('\n')).split('\n').slice(-LOG_MAX_LINES);
  let bytes = kept.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  while (bytes > LOG_MAX_BYTES && kept.length > 1) {
    bytes -= Buffer.byteLength(kept[0] ?? '') + 1;
    kept = kept.slice(1);
  }
  const text = kept.join('\n');
  if (Buffer.byteLength(text) <= LOG_MAX_BYTES) return text;
  // One line longer than the bound: keep its end, from a character boundary.
  return Buffer.from(text).subarray(-LOG_MAX_BYTES).toString('utf8').replace(/^\uFFFD+/, '');
};

/** CloudWatch Logs: pages back from the stream's end (`GetLogEvents`, `startFromHead: false`) until it has enough lines. */
export class CloudWatchBuildLogReader implements BuildLogReader {
  private readonly clients = new Map<string, CloudWatchLogsClient>();

  async tail(region: string, group: string, stream: string, mask?: (text: string) => string): Promise<string> {
    const client = this.client(region);
    let lines: string[] = [];
    let token: string | undefined;
    try {
      for (;;) {
        const page = await client.send(
          new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, startFromHead: false, limit: LOG_MAX_LINES, nextToken: token }),
          { abortSignal: AbortSignal.timeout(30_000) },
        );
        const events = page.events ?? [];
        lines = [...events.map((e) => (e.message ?? '').replace(/\r?\n$/, '')), ...lines];
        const next = page.nextBackwardToken;
        if (lines.length >= LOG_MAX_LINES || events.length === 0 || next === undefined || next === token) break;
        token = next;
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'AccessDeniedException' || name === 'AccessDenied') {
        throw new LogAccessDenied(`slop's role may not read ${group} (needs logs:GetLogEvents)`);
      }
      if (name === 'ResourceNotFoundException') throw new LogNotReady(`${group}/${stream} is not readable yet`);
      throw error;
    }
    if (lines.length === 0) throw new LogNotReady(`${group}/${stream} has no lines yet`);
    return tailOf(lines, mask);
  }

  private client(region: string): CloudWatchLogsClient {
    let client = this.clients.get(region);
    if (client === undefined) {
      client = new CloudWatchLogsClient({ region });
      this.clients.set(region, client);
    }
    return client;
  }
}
