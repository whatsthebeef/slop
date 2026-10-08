import type { NotificationService, Result } from '@slop/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface NotificationRoutesDeps {
  readonly notifications: Pick<NotificationService, 'list' | 'dismiss'>;
}

const send = <T>(c: Context<Env>, result: Result<T>) =>
  result.ok ? c.json({ value: result.value }) : c.json(errorBody(result.error), statusOf(result.error));

/** The board's notifications for the bar on every board page, and dismissing the ones that allow it. */
export const mountNotifications = (app: Hono<Env>, deps: NotificationRoutesDeps): void => {
  app.get('/api/boards/:b/notifications', async (c) =>
    send(c, await deps.notifications.list(c.get('email'), Number(c.req.param('b')))),
  );

  app.post('/api/boards/:b/notifications/dismiss', async (c) => {
    const body = z.object({ id: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: 'invalid_input', message: 'An id is required' }, 400);
    return send(c, await deps.notifications.dismiss(c.get('email'), Number(c.req.param('b')), body.data.id));
  });
};
