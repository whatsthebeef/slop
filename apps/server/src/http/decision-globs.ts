import { KNOWLEDGE_KINDS } from '@slop/core';
import type { DecisionGlobService, GlobService } from '@slop/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './app.js';
import { errorBody, globViewOf, statusOf } from './views.js';

export interface DecisionGlobRoutesDeps {
  readonly decisions: Pick<DecisionGlobService, 'decide' | 'assess' | 'diff'>;
  readonly globs: Pick<GlobService, 'get'>;
}

const decideSchema = z.object({
  version: z.number().int(),
  outcome: z.enum(['accept', 'accept_with_edits', 'retarget', 'needs_work', 'reject']),
  reason: z.string().max(2000).optional(),
  editedDraft: z.string().max(200_000).optional(),
  /** Retarget: the item's new target (see `TargetChange` in core). */
  target: z
    .object({
      kind: z.enum(KNOWLEDGE_KINDS),
      name: z.string().min(1).max(400),
      section: z.string().max(400).nullable(),
      newDocument: z
        .object({
          area: z.string().min(1).max(200),
          audience: z.array(z.string().min(1).max(100)).max(50),
          description: z.string().min(1).max(1000),
        })
        .nullable()
        .optional(),
    })
    .optional(),
  linkedGlobId: z.string().min(1).optional(),
});

/** The routes of decision globs beyond the shared glob routes: the outcome, the diff and the assessment. */
export const mountDecisionGlobs = (app: Hono<Env>, deps: DecisionGlobRoutesDeps): void => {
  const fail = (c: Context<Env>, error: Parameters<typeof statusOf>[0]) => c.json(errorBody(error), statusOf(error));

  app.post('/api/globs/:id/decision', async (c) => {
    const parsed = decideSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'invalid_input', message: z.prettifyError(parsed.error) }, 422);
    const { version, ...input } = parsed.data;
    const email = c.get('email');
    const decided = await deps.decisions.decide(email, c.req.param('id'), version, input);
    if (!decided.ok) return fail(c, decided.error);
    const view = await deps.globs.get(email, decided.value.id);
    return view.ok ? c.json(globViewOf(view.value)) : fail(c, view.error);
  });

  // What approving would change: the item's target and the line diff (preview null: no proposed change yet).
  app.get('/api/globs/:id/diff', async (c) => {
    const result = await deps.decisions.diff(c.get('email'), c.req.param('id'));
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  // The "Assess" button: writes (or refreshes) the glob's assessment for decisions that came from people.
  app.post('/api/globs/:id/assessment', async (c) => {
    const result = await deps.decisions.assess(c.get('email'), c.req.param('id'));
    return result.ok ? c.json({ kind: result.value.kind, version: result.value.version, content: result.value.content }) : fail(c, result.error);
  });
};
