import type { InboxService } from '@slop/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import { peopleIn, renderThread, slackIso, verifySlackSignature } from '../slack.js';
import type { SlackApi } from '../slack.js';
import type { Env } from './app.js';

export interface SlackRoutesDeps {
  readonly signingSecret: string;
  /** Workspace (team) ID → board. A workspace that isn't here gets an error back in Slack. */
  readonly workspaces: ReadonlyMap<string, number>;
  readonly api: SlackApi;
  readonly inbox: Pick<InboxService, 'addFromSource'>;
  /** Where the inbox is, for the link in the reply. */
  readonly publicUrl: string;
  /** Posts the sender-only reply to the payload's `response_url`; defaults to a plain fetch. */
  readonly respond?: (responseUrl: string, body: object) => Promise<void>;
  readonly now?: () => number;
  /** Runs the work after the ack; production lets it run on its own, tests wait for it. */
  readonly background?: (work: Promise<void>) => void;
  readonly logError?: (message: string) => void;
}

/** The "Send to slop" message shortcut's payload (`type: message_action`); the rest of Slack's fields are ignored. */
const shortcut = z.object({
  type: z.literal('message_action'),
  callback_id: z.string(),
  response_url: z.url(),
  team: z.object({ id: z.string().min(1) }),
  user: z.object({ id: z.string().min(1) }),
  channel: z.object({ id: z.string().min(1) }),
  message: z.object({ ts: z.string().min(1), thread_ts: z.string().optional(), text: z.string().optional() }),
});

export const SLACK_CALLBACK_ID = 'send_to_slop';
const SLACK_SOURCE = 'slack';
const TITLE_CHARS = 80;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Slack interactivity (spec, Inbox and ingest): the "Send to slop" shortcut files the message's thread in the workspace's board inbox. */
export const mountSlack = (app: Hono<Env>, deps: SlackRoutesDeps): void => {
  const now = deps.now ?? Date.now;
  const background = deps.background ?? ((work: Promise<void>) => void work);

  const respond =
    deps.respond ??
    (async (responseUrl: string, body: object): Promise<void> => {
      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    });

  /** The reply only the sender sees, posted to the payload's `response_url`; a failure to post is logged, never thrown. */
  const reply = async (responseUrl: string, text: string): Promise<void> => {
    try {
      await respond(responseUrl, { response_type: 'ephemeral', replace_original: false, text });
    } catch (error) {
      deps.logError?.(`Slack reply failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

  const send = async (payload: z.infer<typeof shortcut>): Promise<string> => {
    const board = deps.workspaces.get(payload.team.id);
    if (board === undefined)
      return `This Slack workspace (${payload.team.id}) isn't linked to a slop board. Ask a slop admin to add it to the server's SLACK_WORKSPACES.`;
    const root = payload.message.thread_ts ?? payload.message.ts;
    try {
      const [messages, permalink] = await Promise.all([
        deps.api.replies(payload.channel.id, root),
        deps.api.permalink(payload.channel.id, root),
      ]);
      if (messages.length === 0) return 'Slack gave no messages for that thread.';
      const names = new Map<string, string>();
      for (const id of peopleIn(messages)) {
        const name = await deps.api.userName(id).catch(() => null);
        if (name !== null) names.set(id, name);
      }
      const first = messages[0];
      const result = await deps.inbox.addFromSource(board, {
        source: SLACK_SOURCE,
        sourceRef: permalink,
        text: renderThread(messages, names, permalink),
        title: `Slack: ${oneLine(first?.text ?? '').slice(0, TITLE_CHARS)}`.trim(),
        sourceLabel: 'Slack thread',
        sourceType: 'thread',
        occurredAt: slackIso(root) ?? new Date(now()).toISOString(),
        createdBy: `slack:${payload.user.id}`,
      });
      if (!result.ok) return `slop couldn't file the thread: ${result.error.message}`;
      const link = `${deps.publicUrl.replace(/\/$/, '')}/boards/${String(board)}/inbox?item=${String(result.value.id)}`;
      return result.value.created ? `Sent to the slop inbox: ${link}` : `Already in the slop inbox, updated: ${link}`;
    } catch (error) {
      deps.logError?.(`Slack thread failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return `slop couldn't read the thread: ${error instanceof Error ? error.message : 'unknown error'}. The slop app must be in the channel (/invite it).`;
    }
  };

  app.post('/integrations/slack/interactivity', async (c) => {
    // The signature covers the raw body, so read it as text before anything parses it.
    const raw = await c.req.text();
    const check = verifySlackSignature(
      deps.signingSecret,
      c.req.header('x-slack-request-timestamp'),
      c.req.header('x-slack-signature'),
      raw,
      Math.floor(now() / 1000),
    );
    if (check !== 'ok') return c.json({ error: check === 'stale' ? 'The request is too old' : 'Bad signature' }, 401);
    const form = new URLSearchParams(raw).get('payload');
    const json = ((): unknown => {
      try {
        return form === null ? null : JSON.parse(form);
      } catch {
        return null;
      }
    })();
    const parsed = shortcut.safeParse(json);
    if (!parsed.success || parsed.data.callback_id !== SLACK_CALLBACK_ID) return c.json({ error: 'Not a Send to slop shortcut' }, 400);
    const payload = parsed.data;
    // Slack wants an answer in 3 seconds: ack now, fetch the thread and reply afterwards.
    background(send(payload).then((text) => reply(payload.response_url, text)));
    return c.body(null, 200);
  });
};
