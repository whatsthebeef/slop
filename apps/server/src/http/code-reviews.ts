import type { CodeReviewService, Result } from '@slop/core';
import type { Context, Hono } from 'hono';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface CodeReviewRoutesDeps {
  readonly codeReviews: Pick<CodeReviewService, 'boardBadges' | 'forGlob'>;
}

const send = <T>(c: Context<Env>, result: Result<T>) =>
  result.ok ? c.json({ value: result.value }) : c.json(errorBody(result.error), statusOf(result.error));

/** CodeRabbit's stored reviews (R3): the cards' badges and one glob's items. They live beside the glob. */
export const mountCodeReviews = (app: Hono<Env>, deps: CodeReviewRoutesDeps): void => {
  app.get('/api/boards/:b/code-reviews', async (c) => {
    const globIds = (c.req.query('globs') ?? '').split(',').filter((id) => id !== '');
    const badges = await deps.codeReviews.boardBadges(c.get('email'), Number(c.req.param('b')), globIds);
    return badges.ok ? c.json({ value: Object.fromEntries(badges.value) }) : send(c, badges);
  });

  app.get('/api/globs/:id/code-review', async (c) => send(c, await deps.codeReviews.forGlob(c.get('email'), c.req.param('id'))));
};
