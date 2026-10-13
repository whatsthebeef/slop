import { basename } from 'node:path';
import { z } from 'zod';
import { SlopError, UsageError } from './errors.js';
import type { Fetch } from './http.js';
import type { ToolCaller } from './init.js';
import { describeError } from './util.js';

export const ATTACH_USAGE = 'attach <glob> <file>... [--label <text>] [--json]';

/** How long to wait for slop to see an uploaded file, and the polling delays. */
const SEEN_TIMEOUT_MS = 60_000;
const FIRST_POLL_DELAY_MS = 500;
const MAX_POLL_DELAY_MS = 4_000;

export interface AttachDeps {
  readonly client: ToolCaller & {
    rest: (method: string, path: string, body?: unknown) => Promise<unknown>;
  };
  readonly fetch: Fetch;
  /** Reads a file's bytes; tests inject a fake. */
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly stdout: (text: string) => void;
  readonly log: (message: string) => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const uploadLinkSchema = z.object({
  attachmentId: z.string().optional(),
  label: z.string(),
  url: z.string(),
  fields: z.record(z.string(), z.string()),
  expiresAt: z.string().optional(),
});

const artifactSchema = z.object({
  file: z
    .object({ state: z.enum(['pending', 'stored', 'missing']), reason: z.string().nullish() })
    .nullish(),
});

interface Outcome {
  readonly file: string;
  readonly label?: string;
  readonly state: 'stored' | 'missing' | 'pending' | 'failed';
  readonly detail?: string;
}

/** `slop attach`: asks slop for an upload link per file, POSTs the bytes to S3 and waits for slop to see each file. */
export async function attachCommand(args: readonly string[], deps: AttachDeps): Promise<void> {
  const usage = `usage: slop ${ATTACH_USAGE}`;
  const paths: string[] = [];
  let label: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--label') {
      label = args[++i];
      if (label === undefined || label === '') throw new UsageError(`--label needs a value\n${usage}`);
    } else if (arg === '--json') json = true;
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}\n${usage}`);
    else paths.push(arg);
  }
  const [globId, ...files] = paths;
  if (globId === undefined || files.length === 0) throw new UsageError(usage);
  if (label !== undefined && files.length > 1) {
    throw new UsageError('--label names one file; attach several files without it (each label is its file name)');
  }

  const outcomes: Outcome[] = [];
  for (const file of files) outcomes.push(await attachOne(deps, globId, file, label));

  if (json) deps.stdout(`${JSON.stringify(outcomes)}\n`);
  for (const o of outcomes) {
    deps.log(o.state === 'stored' ? `slop: attached ${o.file} to ${globId}` : `slop: ${o.file}: ${o.state}${o.detail === undefined ? '' : ` (${o.detail})`}`);
  }
  const bad = outcomes.filter((o) => o.state !== 'stored');
  if (bad.length > 0) {
    throw new SlopError(`${String(bad.length)} of ${String(outcomes.length)} files did not arrive; upload them in the glob view`);
  }
}

async function attachOne(deps: AttachDeps, globId: string, path: string, label: string | undefined): Promise<Outcome> {
  const fileName = basename(path);
  let bytes: Uint8Array;
  try {
    bytes = await deps.readBytes(path);
  } catch (error) {
    throw new SlopError(`attach: could not read ${path}: ${describeError(error)}`);
  }
  if (bytes.length === 0) throw new SlopError(`attach: ${path} is empty`);

  const link = uploadLinkSchema.safeParse(
    await deps.client.rest('POST', `/api/globs/${encodeURIComponent(globId)}/attachment-files`, {
      fileName,
      ...(label === undefined ? {} : { label }),
    }),
  );
  if (!link.success) throw new SlopError('attach: unexpected upload link from slop');

  // Every policy field first, the file last (S3 ignores fields after it).
  const form = new FormData();
  for (const [name, value] of Object.entries(link.data.fields)) form.append(name, value);
  form.append('file', new Blob([bytes as BlobPart]), fileName);
  let response: Response;
  try {
    response = await deps.fetch(link.data.url, { method: 'POST', body: form });
  } catch (error) {
    return { file: path, label: link.data.label, state: 'failed', detail: `could not reach the upload host: ${describeError(error)}` };
  }
  if (response.status < 200 || response.status >= 300) {
    const why = /<Message>(.*?)<\/Message>/s.exec(await response.text().catch(() => ''))?.[1];
    return {
      file: path,
      label: link.data.label,
      state: 'failed',
      detail: `upload refused, HTTP ${String(response.status)}${why === undefined ? '' : `: ${why}`}`,
    };
  }

  return waitUntilSeen(deps, globId, path, link.data.label);
}

/** Polls the attachment until slop has seen the object (stored) or refused it (missing). */
async function waitUntilSeen(deps: AttachDeps, globId: string, file: string, label: string): Promise<Outcome> {
  const deadline = deps.now() + SEEN_TIMEOUT_MS;
  let delay = FIRST_POLL_DELAY_MS;
  for (;;) {
    const artifact = artifactSchema.safeParse(await deps.client.call('get_artifact', { id: globId, kind: 'attachment', label }));
    const state = artifact.success ? (artifact.data.file?.state ?? 'pending') : 'pending';
    if (state === 'stored') return { file, label, state };
    if (state === 'missing') {
      return { file, label, state, ...(artifact.success && artifact.data.file?.reason ? { detail: artifact.data.file.reason } : {}) };
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) return { file, label, state: 'pending', detail: 'uploaded, but slop has not seen it yet; it will show once it does' };
    await deps.sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
  }
}
