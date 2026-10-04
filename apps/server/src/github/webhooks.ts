import { verify } from '@octokit/webhooks-methods';
import type { Hono } from 'hono';
import type { Env } from '../http/app.js';
import type { AppCredentialsStore } from './credentials.js';

export interface Delivery {
  readonly id: string;
  readonly event: string;
  readonly payload: unknown;
}

/** Handles one verified delivery; returns false if it was a duplicate. */
export type DeliveryHandler = (delivery: Delivery) => Promise<boolean>;

/**
 * Inbound GitHub App webhooks: verifies `X-Hub-Signature-256` with the app's webhook secret,
 * then hands the delivery to the handler, which deduplicates by delivery ID.
 */
export const mountGitHubWebhooks = (
  app: Hono<Env>,
  deps: { credentials: AppCredentialsStore; handle: DeliveryHandler; log: (task: string, message: string) => void },
) => {
  app.post('/webhooks/github', async (c) => {
    const credentials = deps.credentials.get();
    if (credentials === null) return c.json({ error: 'GitHub App not set up' }, 503);
    const body = await c.req.text();
    const signature = c.req.header('x-hub-signature-256') ?? '';
    if (!(await verify(credentials.webhook_secret, body, signature).catch(() => false))) {
      return c.json({ error: 'bad signature' }, 401);
    }
    const id = c.req.header('x-github-delivery') ?? '';
    const event = c.req.header('x-github-event') ?? '';
    if (id === '' || event === '') return c.json({ error: 'missing delivery headers' }, 400);
    try {
      const fresh = await deps.handle({ id, event, payload: JSON.parse(body) as unknown });
      return c.json({ ok: true, duplicate: !fresh }, 202);
    } catch (error) {
      deps.log(`webhook ${event}`, `${id}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      // GitHub shows failed deliveries in the app settings, where they can be redelivered by hand.
      return c.json({ error: 'handler failed' }, 500);
    }
  });
};
