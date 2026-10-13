import type { AttachmentService } from '@slop/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

export interface AttachmentRoutesDeps {
  readonly attachments: Pick<AttachmentService, 'createUpload' | 'downloadUrl' | 'detach'>;
}

const uploadBody = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().max(200).optional(),
  label: z.string().min(1).max(200).optional(),
});

const labelQuery = z.string().min(1).max(200);

/**
 * File attachments of a glob. Only board members can ask for an upload link or a download link (the service checks);
 * the bytes go straight between the client and the bucket.
 */
export const mountAttachments = (app: Hono<Env>, deps: AttachmentRoutesDeps): void => {
  const { attachments } = deps;
  const fail = (c: Context<Env>, error: Parameters<typeof statusOf>[0]) => c.json(errorBody(error), statusOf(error));
  const label = (c: Context<Env>) => labelQuery.safeParse(c.req.query('label'));

  // A presigned POST for a new file (or the missing one with this label): the pending attachment is created with the link.
  app.post('/api/globs/:id/attachment-files', async (c) => {
    const body = uploadBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ code: 'invalid_input', message: z.prettifyError(body.error) }, 422);
    const made = await attachments.createUpload(c.get('email'), c.req.param('id'), body.data);
    if (!made.ok) return fail(c, made.error);
    const { artifact, upload, expiresAt } = made.value;
    return c.json({ attachmentId: artifact.id, label: artifact.label, file: artifact.file, url: upload.url, fields: upload.fields, expiresAt }, 201);
  });

  // A fresh download link for a stored file (JSON, so the page fetches it with its own session and then opens the link).
  app.get('/api/globs/:id/attachment-files/download', async (c) => {
    const wanted = label(c);
    if (!wanted.success) return c.json({ code: 'invalid_input', message: 'label is required' }, 422);
    const link = await attachments.downloadUrl(c.get('email'), c.req.param('id'), wanted.data);
    return link.ok ? c.json(link.value) : fail(c, link.error);
  });

  app.delete('/api/globs/:id/attachment-files', async (c) => {
    const wanted = label(c);
    if (!wanted.success) return c.json({ code: 'invalid_input', message: 'label is required' }, 422);
    const removed = await attachments.detach(c.get('email'), c.req.param('id'), wanted.data);
    return removed.ok ? c.body(null, 204) : fail(c, removed.error);
  });
};
