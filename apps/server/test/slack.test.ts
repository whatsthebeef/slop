import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/http/app.js';
import { mountSlack, SLACK_CALLBACK_ID } from '../src/http/slack.js';
import type { SlackRoutesDeps } from '../src/http/slack.js';
import { renderThread, slackApi, verifySlackSignature } from '../src/slack.js';
import type { SlackApi, SlackFetch, SlackMessage } from '../src/slack.js';

const SECRET = 'shh-signing-secret';
const NOW_MS = Date.parse('2026-10-09T14:10:00Z');
const NOW_S = Math.floor(NOW_MS / 1000);
const sign = (body: string, ts: number) => `v0=${createHmac('sha256', SECRET).update(`v0:${String(ts)}:${body}`).digest('hex')}`;

describe('slack signature', () => {
  const body = 'payload=%7B%7D';
  it('accepts a good signature, refuses a stale or a bad one', () => {
    expect(verifySlackSignature(SECRET, String(NOW_S), sign(body, NOW_S), body, NOW_S)).toBe('ok');
    expect(verifySlackSignature(SECRET, String(NOW_S - 301), sign(body, NOW_S - 301), body, NOW_S)).toBe('stale');
    expect(verifySlackSignature(SECRET, String(NOW_S), sign('other', NOW_S), body, NOW_S)).toBe('bad');
    expect(verifySlackSignature('wrong', String(NOW_S), sign(body, NOW_S), body, NOW_S)).toBe('bad');
    expect(verifySlackSignature(SECRET, undefined, sign(body, NOW_S), body, NOW_S)).toBe('bad');
    expect(verifySlackSignature(SECRET, String(NOW_S), undefined, body, NOW_S)).toBe('bad');
    expect(verifySlackSignature(SECRET, String(NOW_S), 'v0=abc', body, NOW_S)).toBe('bad');
  });
});

const THREAD: SlackMessage[] = [
  { ts: '1791554580.000200', user: 'U1', text: 'Can we move sync to a websocket? cc <@U2> &amp; <https://example.com/rfc|the RFC>' },
  { ts: '1791554640.000300', user: 'U2', text: 'Yes, see <#C1|eng> <!here>' },
  { ts: '1791554700.000400', username: 'deploy-bot', text: 'ok' },
];

describe('renderThread', () => {
  it('writes the permalink, then each message with its time and name, mentions and links made readable', () => {
    const text = renderThread(THREAD, new Map([['U1', 'Ana'], ['U2', 'Ben']]), 'https://acme.slack.com/archives/C1/p1');
    expect(text).toBe(
      [
        'Slack thread: https://acme.slack.com/archives/C1/p1',
        '[2026-10-09 14:03 UTC] Ana: Can we move sync to a websocket? cc @Ben & the RFC (https://example.com/rfc)',
        '[2026-10-09 14:04 UTC] Ben: Yes, see #eng @here',
        '[2026-10-09 14:05 UTC] deploy-bot: ok',
      ].join('\n\n'),
    );
  });
});

describe('slackApi', () => {
  it('pages through replies and reports Slack error codes', async () => {
    const urls: string[] = [];
    const fetcher: SlackFetch = (url) => {
      urls.push(url);
      const page = urls.length;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            page === 1
              ? { ok: true, messages: [{ ts: '1.1', user: 'U1', text: 'a' }], response_metadata: { next_cursor: 'c2' } }
              : page === 2
                ? { ok: true, messages: [{ ts: '2.2', user: 'U2', text: 'b' }] }
                : { ok: false, error: 'not_in_channel' },
          ),
      });
    };
    const api = slackApi('xoxb-token', fetcher);
    expect((await api.replies('C1', '1.1')).map((m) => m.text)).toEqual(['a', 'b']);
    expect(urls[1]).toContain('cursor=c2');
    await expect(api.permalink('C1', '1.1')).rejects.toThrow('not_in_channel');
  });
});

describe('POST /integrations/slack/interactivity', () => {
  const calls: { board: number; input: Parameters<SlackRoutesDeps['inbox']['addFromSource']>[1] }[] = [];
  const replies: { url: string; body: object }[] = [];
  const pending: Promise<void>[] = [];
  const names: Record<string, string> = { U1: 'Ana', U2: 'Ben' };
  let apiFails = false;
  let created = true;

  const api: SlackApi = {
    replies: (_c, ts) => (apiFails ? Promise.reject(new Error('Slack conversations.replies failed: not_in_channel')) : Promise.resolve(ts === '1791554580.000200' ? THREAD : [])),
    permalink: () => Promise.resolve('https://acme.slack.com/archives/C1/p1791554580000200'),
    userName: (id) => Promise.resolve(names[id] ?? null),
  };
  const app = new Hono<Env>();
  mountSlack(app, {
    signingSecret: SECRET,
    workspaces: new Map([['T1', 15]]),
    api,
    inbox: {
      addFromSource: (board, input) => {
        calls.push({ board, input });
        return Promise.resolve({ ok: true as const, value: { id: 7, created } });
      },
    },
    publicUrl: 'https://slop.example.com/',
    now: () => NOW_MS,
    respond: (url, body) => {
      replies.push({ url, body });
      return Promise.resolve();
    },
    background: (work) => { pending.push(work); },
  });

  const payload = (patch: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'message_action',
      callback_id: SLACK_CALLBACK_ID,
      response_url: 'https://hooks.slack.com/actions/T1/1/x',
      team: { id: 'T1' },
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: '1791554640.000300', thread_ts: '1791554580.000200', text: 'Yes' },
      ...patch,
    });
  const post = async (json: string, opts: { ts?: number; signWith?: string } = {}) => {
    const body = new URLSearchParams({ payload: json }).toString();
    const ts = opts.ts ?? NOW_S;
    const response = await app.request('/integrations/slack/interactivity', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': opts.signWith ?? sign(body, ts),
      },
      body,
    });
    await Promise.all(pending.splice(0));
    return response;
  };

  it('refuses a bad or stale signature and does nothing', async () => {
    calls.length = 0;
    expect((await post(payload(), { signWith: 'v0=00' })).status).toBe(401);
    expect((await post(payload(), { ts: NOW_S - 600 })).status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it('acks at once, then files the whole thread under the permalink and replies with the inbox link', async () => {
    calls.length = 0;
    replies.length = 0;
    const response = await post(payload());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.board).toBe(15);
    expect(call?.input).toMatchObject({
      source: 'slack',
      sourceRef: 'https://acme.slack.com/archives/C1/p1791554580000200',
      sourceType: 'thread',
      createdBy: 'slack:U1',
      occurredAt: '2026-10-09T14:03:00.000Z',
    });
    expect(call?.input.text).toContain('Ana: Can we move sync');
    expect(call?.input.text).toContain('Ben: Yes');
    expect(call?.input.title).toMatch(/^Slack: Can we move sync/);
    expect(replies).toEqual([
      {
        url: 'https://hooks.slack.com/actions/T1/1/x',
        body: { response_type: 'ephemeral', replace_original: false, text: 'Sent to the slop inbox: https://slop.example.com/boards/15/inbox?item=7' },
      },
    ]);
  });

  it('says so when the thread was already in the inbox', async () => {
    replies.length = 0;
    created = false;
    await post(payload());
    created = true;
    expect(JSON.stringify(replies[0]?.body)).toContain('Already in the slop inbox, updated');
  });

  it('files a single message under its own timestamp', async () => {
    calls.length = 0;
    await post(payload({ message: { ts: '1791554580.000200', text: 'Can we' } }));
    expect(calls[0]?.input.occurredAt).toBe('2026-10-09T14:03:00.000Z');
  });

  it('tells an unmapped workspace to get linked, and files nothing', async () => {
    calls.length = 0;
    replies.length = 0;
    expect((await post(payload({ team: { id: 'T9' } }))).status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(replies[0]?.body)).toContain("isn't linked to a slop board");
  });

  it('replies with the Slack error when the thread cannot be read', async () => {
    calls.length = 0;
    replies.length = 0;
    apiFails = true;
    await post(payload());
    apiFails = false;
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(replies[0]?.body)).toContain('not_in_channel');
  });

  it('refuses a payload that is not the shortcut', async () => {
    expect((await post(payload({ callback_id: 'other' }))).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
  });
});
