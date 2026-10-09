import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a request's timestamp may be from now (Slack's own advice: five minutes), against replays. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureCheck = 'ok' | 'stale' | 'bad';

/** Slack's `v0` request signature: HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the app's signing secret. */
export const verifySlackSignature = (
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  nowSeconds: number,
): SignatureCheck => {
  if (timestamp === undefined || signature === undefined || !/^\d{1,12}$/.test(timestamp)) return 'bad';
  const expected = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`);
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'bad';
  return Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS ? 'stale' : 'ok';
};

export interface SlackMessage {
  readonly ts: string;
  readonly user?: string | undefined;
  readonly username?: string | undefined;
  readonly text: string;
}

/** The three Slack Web API calls the shortcut needs; the bot token is the adapter's. */
export interface SlackApi {
  /** The thread's messages, oldest first (the root included); a message with no replies is a thread of one. */
  replies(channel: string, ts: string): Promise<SlackMessage[]>;
  permalink(channel: string, ts: string): Promise<string>;
  /** A person's display name, or null when Slack doesn't give one. */
  userName(id: string): Promise<string | null>;
}

export type SlackFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value.map((v: unknown) => v) : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const REPLY_PAGE = 200;
const MAX_PAGES = 10;

/** Slack's Web API over `fetch`: every call answers `{ ok, error? }`, and a failure keeps Slack's error code. */
export const slackApi = (token: string, fetcher: SlackFetch): SlackApi => {
  const call = async (method: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    const response = await fetcher(`https://slack.com/api/${method}?${new URLSearchParams(params).toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body)) throw new Error(`Slack ${method} failed (HTTP ${String(response.status)})`);
    if (body.ok !== true) throw new Error(`Slack ${method} failed: ${str(body.error) ?? 'unknown_error'}`);
    return body;
  };
  return {
    async replies(channel, ts) {
      const messages: SlackMessage[] = [];
      let cursor = '';
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await call('conversations.replies', {
          channel,
          ts,
          limit: String(REPLY_PAGE),
          ...(cursor === '' ? {} : { cursor }),
        });
        const raw = list(body.messages);
        for (const m of raw) {
          if (!isRecord(m)) continue;
          const mts = str(m.ts);
          if (mts === undefined) continue;
          messages.push({ ts: mts, user: str(m.user), username: str(m.username), text: str(m.text) ?? '' });
        }
        const meta = body.response_metadata;
        cursor = isRecord(meta) ? (str(meta.next_cursor) ?? '') : '';
        if (cursor === '') break;
      }
      return messages;
    },
    async permalink(channel, ts) {
      const link = str((await call('chat.getPermalink', { channel, message_ts: ts })).permalink);
      if (link === undefined) throw new Error('Slack chat.getPermalink gave no link');
      return link;
    },
    async userName(id) {
      const body = await call('users.info', { user: id });
      const user = body.user;
      if (!isRecord(user)) return null;
      const profile = isRecord(user.profile) ? user.profile : {};
      return str(profile.display_name) || str(profile.real_name) || str(user.real_name) || str(user.name) || null;
    },
  };
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** `2026-10-09 14:03 UTC` for a Slack timestamp (`1791554580.000200`). */
export const slackTime = (ts: string): string => {
  const d = new Date(Number.parseFloat(ts) * 1000);
  if (Number.isNaN(d.getTime())) return ts;
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

/** The ISO time of a Slack timestamp, or null when it isn't one. */
export const slackIso = (ts: string): string | null => {
  const d = new Date(Number.parseFloat(ts) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Slack escapes `&`, `<` and `>` in message text, and writes mentions and links as `<...>`. */
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** The user IDs a thread mentions or is written by. */
export const peopleIn = (messages: readonly SlackMessage[]): string[] => {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.user !== undefined) ids.add(m.user);
    for (const match of m.text.matchAll(MENTION)) if (match[1] !== undefined) ids.add(match[1]);
  }
  return [...ids];
};

const plain = (text: string, names: ReadonlyMap<string, string>): string =>
  text
    .replace(MENTION, (_all, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The thread as text for the inbox: a header with its permalink, then one line group per message with name and time. */
export const renderThread = (
  messages: readonly SlackMessage[],
  names: ReadonlyMap<string, string>,
  permalink: string,
): string => {
  const lines = messages.map((m) => {
    const who = m.user === undefined ? (m.username ?? 'Unknown') : (names.get(m.user) ?? m.user);
    return `[${slackTime(m.ts)}] ${who}: ${plain(m.text, names).trim()}`;
  });
  return [`Slack thread: ${permalink}`, ...lines].join('\n\n');
};
