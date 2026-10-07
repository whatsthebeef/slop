import type { Hono } from 'hono';
import type { LlmHealth } from '../llm-health.js';
import type { Env } from './app.js';

/** Whether slop's LLM is usable, for any signed-in person (the `/api/*` sign-in check applies). */
export const mountHealth = (app: Hono<Env>, deps: { readonly llm: LlmHealth }): void => {
  app.get('/api/health', (c) => c.json({ llm: deps.llm.state() }));
};
