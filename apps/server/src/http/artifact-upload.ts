import type { ArtifactKind, ArtifactService, GlobService, ReviewStats } from '@slop/core';
import { machine, RISK_TIERS } from '@slop/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { SignedLinks } from '../signed-links.js';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

/** How long an upload URL works, and the most an upload may carry (bytes). */
export const UPLOAD_TTL_SECONDS = 300;
export const MAX_UPLOAD_BYTES = 1_048_576;

const UPLOAD_PREFIX = '/uploads/artifact/';

const payloadSchema = z.object({
  id: z.string(),
  kind: z.enum(['implementation_plan', 'postplan', 'local_review']),
  email: z.string(),
  commitSha: z.string().nullable(),
  runId: z.string().nullable(),
  agentSetVersion: z.number().int().nonnegative().nullable(),
  reviewStats: z
    .object({
      riskTier: z.enum(RISK_TIERS),
      reviewRounds: z.number().int().min(0).max(20),
      maxReviewRounds: z.number().int().min(0).max(20),
      testFailRounds: z.number().int().min(0).max(20),
    })
    .nullable(),
  // Makes every URL unique, so two identical requests never share a signature.
  nonce: z.string(),
});

export interface UploadRequest {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly email: string;
  readonly commitSha: string | null;
  readonly runId: string | null;
  readonly agentSetVersion: number | null;
  readonly reviewStats: ReviewStats | null;
}

/** A signed, expiring URL that accepts one POST of the artifact's text, as `email`, with these fields fixed. */
export const issueUploadUrl = (
  links: SignedLinks,
  origin: string,
  request: UploadRequest,
  nonce: string,
) => {
  const payload = Buffer.from(JSON.stringify({ ...request, nonce })).toString('base64url');
  const path = `${UPLOAD_PREFIX}${payload}`;
  const { expires, signature } = links.sign(path, UPLOAD_TTL_SECONDS);
  return {
    url: `${origin}${path}?expires=${String(expires)}&signature=${signature}`,
    expiresAt: new Date(expires * 1000).toISOString(),
    maxBytes: MAX_UPLOAD_BYTES,
  };
};

export interface ArtifactUploadDeps {
  readonly artifacts: ArtifactService;
  readonly globs: GlobService;
  readonly links: SignedLinks;
}

/** `POST /uploads/artifact/<payload>?expires&signature`: the body is the artifact's text, stored like `put_artifact`. */
export const mountArtifactUploads = (app: Hono<Env>, deps: ArtifactUploadDeps) => {
  // Signatures already used, until they would have expired anyway (single use; per server process).
  const used = new Map<string, number>();

  app.post(`${UPLOAD_PREFIX}:payload`, async (c) => {
    const now = Date.now() / 1000;
    for (const [signature, expires] of used) if (expires < now) used.delete(signature);

    const expires = Number(c.req.query('expires'));
    const signature = c.req.query('signature') ?? '';
    if (!deps.links.verify(c.req.path, expires, signature) || used.has(signature)) {
      return c.json({ error: 'This upload link is invalid, expired or already used' }, 403);
    }
    let parsed: z.infer<typeof payloadSchema>;
    try {
      parsed = payloadSchema.parse(
        JSON.parse(Buffer.from(c.req.param('payload'), 'base64url').toString('utf8')),
      );
    } catch {
      return c.json({ error: 'This upload link is invalid, expired or already used' }, 403);
    }

    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > MAX_UPLOAD_BYTES)
      return c.json({ error: `The upload is over ${String(MAX_UPLOAD_BYTES)} bytes` }, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES)
      return c.json({ error: `The upload is over ${String(MAX_UPLOAD_BYTES)} bytes` }, 413);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return c.json({ error: 'The upload is not valid UTF-8 text' }, 400);
    }
    if (content.trim() === '') return c.json({ error: 'An artifact needs content' }, 400);

    used.set(signature, expires);
    if (parsed.runId !== null) {
      const runId = parsed.runId;
      await deps.globs.applyEvent(parsed.id, (g, ctx) => machine.runProgress(g, runId, ctx));
    }
    const result = await deps.artifacts.putArtifact(parsed.email, parsed.id, parsed.kind, content, {
      commitSha: parsed.commitSha,
      runId: parsed.runId,
      agentSetVersion: parsed.agentSetVersion,
      reviewStats: parsed.reviewStats,
    });
    if (!result.ok) {
      // A failed store doesn't spend the link.
      used.delete(signature);
      return c.json(errorBody(result.error), statusOf(result.error));
    }
    const a = result.value;
    return c.json('ignored' in a ? a : { id: a.id, kind: a.kind, version: a.version });
  });
};
