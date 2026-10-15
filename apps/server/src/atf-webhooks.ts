import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import {
  WEBHOOK_EVENT,
  WEBHOOK_HEADERS,
  addressRefusal,
  deployLiveBody,
  runnerUsable,
  validateWebhookUrl,
  webhookDeliveryId,
  webhookSignatureHeader,
  webhookSignedText,
} from '@slop/core';
import type { Clock, Effect, EffectKind, RunnerWebhooks, Store } from '@slop/core';
import type { Outcome, SettledExecutor } from './jobs/outbox.js';

/**
 * Deploy-live webhooks (spec, ATF runners). A runner that subscribed gets a signed POST when a deploy is live and checked.
 * The signing secret is slop's: made when the webhook is turned on, shown once, and kept sealed (AES-256-GCM under a key
 * derived from `SIGNING_SECRET`) in the runner's config, because an HMAC needs the secret itself, not a hash of it.
 */

const SECRET_PREFIX = 'whsec_';
const KEY_INFO = 'slop-atf-webhook-v1';

/** Makes, seals and opens the per-runner signing secrets. */
export class WebhookSecrets {
  private readonly key: Buffer;

  constructor(signingKey: string) {
    this.key = Buffer.from(hkdfSync('sha256', signingKey, '', KEY_INFO, 32));
  }

  newSecret(): string {
    return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  }

  seal(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      sealed.toString('base64url'),
    ].join('.');
  }

  /** The secret, or null when the value isn't ours or the key changed. */
  open(sealed: string): string | null {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || iv === undefined || tag === undefined || data === undefined)
      return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}

/** The IP addresses a host name has. */
export type WebhookResolver = (hostname: string) => Promise<string[]>;

export const dnsResolver: WebhookResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** A validated destination: the one address to connect to, and the name the certificate and `Host` are checked against. */
export interface PinnedTarget {
  readonly address: string;
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
}

export type TargetAnswer =
  | { readonly ok: true; readonly target: PinnedTarget }
  | { readonly ok: false; readonly reason: string; readonly transient: boolean };

/**
 * Validates the URL and resolves its host once. Every address the name has must be public (one private answer among
 * public ones is how a rebinding attack hides), and the first is the one to connect to, so a second lookup can't change
 * where the request goes.
 */
export const pinTarget = async (raw: string, resolve: WebhookResolver): Promise<TargetAnswer> => {
  const valid = validateWebhookUrl(raw);
  if (!valid.ok) return { ok: false, reason: valid.error.message, transient: false };
  const url = new URL(raw);
  const hostname = valid.value.hostname;
  const bare = hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(bare) !== 0) addresses = [bare];
  else {
    try {
      addresses = await resolve(hostname);
    } catch {
      return { ok: false, reason: `The host ${hostname} could not be resolved`, transient: true };
    }
  }
  const [address] = addresses;
  if (address === undefined)
    return { ok: false, reason: `The host ${hostname} has no address`, transient: true };
  if (addresses.some((a) => addressRefusal(a) !== null)) {
    return {
      ok: false,
      reason: `The host ${hostname} resolves to a private or reserved address`,
      transient: false,
    };
  }
  return {
    ok: true,
    target: {
      address,
      hostname,
      port: url.port === '' ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
    },
  };
};

/** What the registry asks of the server when a runner's webhook is set (core's `RunnerWebhooks`). */
export const runnerWebhooks = (
  secrets: WebhookSecrets,
  resolve: WebhookResolver = dnsResolver,
): RunnerWebhooks => ({
  newSecret: () => secrets.newSecret(),
  seal: (secret) => secrets.seal(secret),
  checkTarget: async (url) => {
    const answer = await pinTarget(url, resolve);
    // A name that doesn't resolve right now is refused too: the person is setting it up and can fix it before saving.
    return answer.ok ? null : answer.reason;
  },
});

export interface WebhookPost {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Sends one POST to a pinned target and answers its status. Throws on a network failure or a timeout. */
export type WebhookTransport = (
  target: PinnedTarget,
  post: WebhookPost,
) => Promise<{ readonly status: number }>;

export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Of the receiver's answer, only the status matters: more than this is dropped on the floor, never buffered. */
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * HTTPS to the address `pinTarget` validated (no second lookup), with the host name as SNI and `Host`, so the certificate
 * is checked against the name. No redirects are followed (a 3xx is just a status), the whole exchange has a deadline, and
 * the answer's body is not kept. `ca` is for tests.
 */
export const httpsTransport =
  (options: { readonly timeoutMs?: number; readonly ca?: string } = {}): WebhookTransport =>
  (target, post) =>
    new Promise((resolve, reject) => {
      if (Buffer.byteLength(post.body) > MAX_REQUEST_BYTES) {
        reject(new Error('The webhook body is too large'));
        return;
      }
      const req = request(
        {
          host: target.address,
          port: target.port,
          path: target.path,
          method: 'POST',
          servername: target.hostname,
          agent: false,
          headers: {
            ...post.headers,
            Host: target.hostname,
            'Content-Length': String(Buffer.byteLength(post.body)),
          },
          signal: AbortSignal.timeout(options.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
          ...(options.ca === undefined ? {} : { ca: options.ca }),
        },
        (res) => {
          let seen = 0;
          res.on('data', (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > WEBHOOK_MAX_RESPONSE_BYTES) res.destroy();
          });
          res.on('error', () => undefined);
          resolve({ status: res.statusCode ?? 0 });
          res.resume();
        },
      );
      req.on('error', reject);
      req.end(post.body);
    });

export interface AtfWebhookDeps {
  readonly store: Pick<Store, 'transaction'>;
  readonly secrets: Pick<WebhookSecrets, 'open'>;
  readonly resolve: WebhookResolver;
  readonly transport: WebhookTransport;
  readonly clock: Clock;
  readonly log: (task: string, message: string) => void;
}

/** `Slop-Signature` for a body: HMAC-SHA256 under the runner's secret over `<timestamp>.<body>`. */
export const signWebhook = (secret: string, timestamp: number, body: string): string =>
  webhookSignatureHeader(
    createHmac('sha256', secret).update(webhookSignedText(timestamp, body)).digest('hex'),
  );

/** A failure code that is safe to keep: never the URL, headers or body. */
const failureCode = (error: unknown): string => {
  if (error instanceof Error)
    return 'code' in error && typeof error.code === 'string' ? error.code : error.name;
  return 'unknown';
};

/**
 * `deliver_atf_webhook`: re-reads the runner and the deploy, then POSTs the signed deploy-live event. Dropped when the runner
 * is gone, off or no longer serves the environment, its webhook was removed, a newer deploy replaced this one, or the URL
 * now resolves to a private address. A network failure, a timeout, a 408, 429 or 5xx is thrown for the outbox to retry; any
 * other answer ends it (a 2xx is delivered, a redirect or 4xx is the receiver's refusal, which a retry won't change).
 * The delivery ID is the same on every retry, so a receiver that got an earlier try can ignore the repeat.
 */
export const deliverAtfWebhook = async (effect: Effect, deps: AtfWebhookDeps): Promise<Outcome> => {
  if (effect.kind !== 'deliver_atf_webhook') return 'dropped';
  const who = `board ${String(effect.boardId)} runner ${String(effect.runnerId)}`;
  const known = await deps.store.transaction(async (tx) => ({
    runner: await tx.getAtfRunner(effect.boardId, effect.runnerId),
    board: await tx.getBoard(effect.boardId),
    latest: await tx.latestEnvironmentDeploy(effect.boardId, effect.environment),
  }));
  const { runner, board, latest } = known;
  const webhook = runner?.config.webhook;
  if (
    runner === null ||
    board === null ||
    !runnerUsable(runner) ||
    !runner.environments.includes(effect.environment)
  )
    return 'dropped';
  if (webhook?.secret === undefined) return 'dropped';
  // A newer deploy replaced this one: its own check delivers its event.
  if (latest?.sha !== effect.sha) return 'dropped';
  const secret = deps.secrets.open(webhook.secret);
  if (secret === null) {
    deps.log(
      'atf webhook',
      `${who}: the signing secret can't be opened (the signing key changed?); turn the webhook off and on again`,
    );
    return 'dropped';
  }
  const pinned = await pinTarget(webhook.url, deps.resolve);
  if (!pinned.ok) {
    deps.log('atf webhook', `${who}: refused: ${pinned.reason}`);
    if (pinned.transient) throw new Error(`${who}: ${pinned.reason}`);
    return 'dropped';
  }
  const deliveryId = webhookDeliveryId(runner.id, effect.deployId);
  const body = deployLiveBody({
    boardId: board.id,
    boardName: board.name,
    environment: effect.environment,
    sha: effect.sha,
    deployId: effect.deployId,
    deployedAt: effect.deployedAt,
    deliveryId,
  });
  const timestamp = Math.floor(Date.parse(deps.clock.now()) / 1000);
  let status: number;
  try {
    ({ status } = await deps.transport(pinned.target, {
      body,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'slop-atf-webhook',
        [WEBHOOK_HEADERS.event]: WEBHOOK_EVENT,
        [WEBHOOK_HEADERS.delivery]: deliveryId,
        [WEBHOOK_HEADERS.timestamp]: String(timestamp),
        [WEBHOOK_HEADERS.signature]: signWebhook(secret, timestamp, body),
      },
    }));
  } catch (error) {
    throw new Error(`${who}: delivery failed (${failureCode(error)})`, { cause: error });
  }
  if (status >= 200 && status < 300) {
    deps.log(
      'atf webhook',
      `${who} ${effect.environment}: delivered deploy ${String(effect.deployId)}`,
    );
    return 'done';
  }
  if (status === 408 || status === 429 || status >= 500)
    throw new Error(`${who}: the receiver answered ${String(status)}`);
  deps.log('atf webhook', `${who}: the receiver answered ${String(status)}; not retried`);
  return 'dropped';
};

export const atfWebhookExecutors = (
  deps: AtfWebhookDeps,
): Partial<Record<EffectKind, SettledExecutor>> => ({
  deliver_atf_webhook: (effect) => deliverAtfWebhook(effect, deps),
});
