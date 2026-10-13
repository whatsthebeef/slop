import { AttachmentService, FakeObjectStore, GlobService } from '@slop/core';
import type { Result } from '@slop/core';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import { PgStore } from '../src/db/store.js';
import type { Database } from '../src/db/store.js';
import type { Env } from '../src/http/app.js';
import { mountAttachments } from '../src/http/attachments.js';
import { createTestDatabase } from './support/database.js';

const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

describe('file attachments on Postgres', () => {
  let drop: () => Promise<void>;
  let db: Database['db'];
  let store: PgStore;
  let objects: FakeObjectStore;
  let attachments: AttachmentService;
  let globs: GlobService;
  let app: Hono<Env>;
  let globId: string;
  let boardId: number;
  let ids = 0;

  /** The keys whose deletion is queued in the outbox. */
  const queuedDeletions = async (): Promise<string[]> => {
    const rows = await db.select().from(schema.outbox).where(eq(schema.outbox.kind, 'delete_object'));
    return rows.flatMap((r) => (r.effect.kind === 'delete_object' ? [r.effect.key] : []));
  };
  const call = (method: string, path: string, email: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'x-email': email, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    const test = await createTestDatabase('attachments');
    drop = test.drop;
    db = test.database.db;
    store = new PgStore(test.database.db);
    objects = new FakeObjectStore();
    const base = { store, notifier: { publish: () => undefined }, clock: { now: () => new Date().toISOString() } };
    attachments = new AttachmentService({ ...base, objects, newId: () => `id-${String(++ids)}` });
    globs = new GlobService({ ...base, ids: { runId: () => crypto.randomUUID() }, routines: { hasRoutine: () => Promise.resolve(false) } });
    boardId = await store.transaction(async (tx) => {
      await tx.upsertUser({ email: DEV, name: 'Dev', active: true });
      await tx.upsertUser({ email: OUTSIDER, name: 'Out', active: true });
      const board = await tx.insertBoard({ name: 'test', repo: null, baseBranch: 'main', timeZone: 'UTC', defaultRoutineOwner: null, environments: [], sensitivePaths: [] });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      return board.id;
    });
    globId = unwrap(
      await globs.create(DEV, { boardId, title: 'Sub', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    ).id;
    app = new Hono<Env>();
    app.use('*', async (c, next) => {
      c.set('email', c.req.header('x-email') ?? '');
      await next();
    });
    mountAttachments(app, { attachments });
  });

  afterAll(async () => {
    await drop();
  });

  it('stores the file facts with the artifact, finds a pending file by its key and only the latest version', async () => {
    const made = unwrap(await attachments.createUpload(DEV, globId, { fileName: 'plot.png' }));
    const key = made.artifact.file?.key ?? '';
    expect(key).toBe(`boards/${String(boardId)}/globs/${globId}/id-1`);
    const found = await store.transaction((tx) => tx.findFileArtifact(key));
    expect(found?.file).toMatchObject({ state: 'pending', fileName: 'plot.png', contentType: 'image/png', size: null });
    expect((await store.transaction((tx) => tx.listPendingFileArtifacts(globId))).map((a) => a.label)).toEqual(['plot.png']);

    objects.put(key, { size: 123, contentType: 'image/png' });
    expect(await attachments.objectArrived(key)).toBe('stored');
    expect((await store.transaction((tx) => tx.findFileArtifact(key)))?.file).toMatchObject({ state: 'stored', size: 123 });
    expect(await store.transaction((tx) => tx.listPendingFileArtifacts())).toEqual([]);
    const versions = await store.transaction((tx) => tx.artifactVersions(globId, 'attachment', 'plot.png'));
    expect(versions.map((v) => v.file?.state)).toEqual(['pending', 'stored']);
  });

  it('leaves text attachments without a file field', async () => {
    const text = await store.transaction((tx) =>
      tx.insertArtifact({ globId, kind: 'attachment', label: 'note', content: 'hi', link: null, commitSha: null, provenance: { by: 'human', actor: DEV, runId: null, agentSetVersion: null }, createdAt: new Date().toISOString() }),
    );
    expect('file' in text).toBe(false);
  });

  it('turns a link nobody used into a missing file in the sweep', async () => {
    const made = unwrap(await attachments.createUpload(DEV, globId, { fileName: 'late.txt' }));
    const late = new AttachmentService({
      store,
      notifier: { publish: () => undefined },
      clock: { now: () => new Date(Date.now() + 3_600_000).toISOString() },
      objects,
      newId: () => 'unused',
    });
    expect((await late.sweep()).expired).toBeGreaterThanOrEqual(1);
    const file = (await store.transaction((tx) => tx.findFileArtifact(made.artifact.file?.key ?? '')))?.file;
    expect(file).toMatchObject({ state: 'missing', reason: null });
  });

  describe('routes', () => {
    it('hands out an upload link for a member, with the pending attachment', async () => {
      const res = await call('POST', `/api/globs/${globId}/attachment-files`, DEV, { fileName: 'log.txt', label: 'Server log' });
      expect(res.status).toBe(201);
      const body: unknown = await res.json();
      expect(body).toMatchObject({
        label: 'Server log',
        url: 'https://fake-bucket.s3.example.com/',
        file: { state: 'pending', fileName: 'log.txt', contentType: 'text/plain' },
      });
      expect(body).toHaveProperty('fields.key');
      expect(body).toHaveProperty('expiresAt');
    });

    it('refuses a bad body, a type that is not accepted and a non-member', async () => {
      expect((await call('POST', `/api/globs/${globId}/attachment-files`, DEV, {})).status).toBe(422);
      expect((await call('POST', `/api/globs/${globId}/attachment-files`, DEV, { fileName: 'x.exe' })).status).toBe(422);
      expect((await call('POST', `/api/globs/${globId}/attachment-files`, OUTSIDER, { fileName: 'x.png' })).status).toBe(403);
      expect((await call('POST', '/api/globs/s9t9/attachment-files', DEV, { fileName: 'x.png' })).status).toBe(404);
    });

    it('mints a download link for a stored file, members only, and detaches it', async () => {
      const made = unwrap(await attachments.createUpload(DEV, globId, { fileName: 'doc.pdf' }));
      const key = made.artifact.file?.key ?? '';
      expect((await call('GET', `/api/globs/${globId}/attachment-files/download?label=doc.pdf`, DEV)).status).toBe(422);
      objects.put(key, { size: 5, contentType: 'application/pdf' });
      await attachments.objectArrived(key);
      const ok = await call('GET', `/api/globs/${globId}/attachment-files/download?label=doc.pdf`, DEV);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ url: `https://fake-bucket.s3.example.com/${key}?ttl=900`, fileName: 'doc.pdf', contentType: 'application/pdf' });
      expect((await call('GET', `/api/globs/${globId}/attachment-files/download?label=doc.pdf`, OUTSIDER)).status).toBe(403);
      expect((await call('GET', `/api/globs/${globId}/attachment-files/download`, DEV)).status).toBe(422);
      expect((await call('DELETE', `/api/globs/${globId}/attachment-files?label=doc.pdf`, OUTSIDER)).status).toBe(403);
      expect((await call('DELETE', `/api/globs/${globId}/attachment-files?label=doc.pdf`, DEV)).status).toBe(204);
      expect(await queuedDeletions()).toContain(key);
      expect((await call('GET', `/api/globs/${globId}/attachment-files/download?label=doc.pdf`, DEV)).status).toBe(404);
    });
  });

  it('removes the objects of a deleted glob', async () => {
    const other = unwrap(
      await globs.create(DEV, { boardId, title: 'Gone', type: 'same', category: 'task', group: null, environment: null, autoTrigger: false, idempotencyKey: null }),
    );
    const made = unwrap(await attachments.createUpload(DEV, other.id, { fileName: 'bye.png' }));
    unwrap(await globs.delete(DEV, other.id, other.version));
    expect(await queuedDeletions()).toContain(made.artifact.file?.key);
  });

  describe('concurrent state changes', () => {
    const versionsOf = async (label: string) => (await store.transaction((tx) => tx.artifactVersions(globId, 'attachment', label))).map((v) => v.file?.state ?? 'cleared');

    it('never brings a detached file back when its object event is handled at the same time', async () => {
      for (let i = 0; i < 8; i++) {
        const label = `race-${String(i)}.png`;
        const made = unwrap(await attachments.createUpload(DEV, globId, { fileName: label }));
        const key = made.artifact.file?.key ?? '';
        objects.put(key, { size: 5, contentType: 'image/png' });
        const [, detached] = await Promise.all([attachments.objectArrived(key), attachments.detach(DEV, globId, label)]);
        expect(detached.ok).toBe(true);
        const states = await versionsOf(label);
        expect(states.at(-1)).toBe('cleared');
        // Whatever the order, at most one version says stored, and it is before the clearing.
        expect(states.filter((x) => x === 'stored').length).toBeLessThanOrEqual(1);
        expect(await queuedDeletions()).toContain(key);
      }
    });

    it('stores a file once when its event and the sweep both find the object', async () => {
      for (let i = 0; i < 8; i++) {
        const label = `both-${String(i)}.png`;
        const made = unwrap(await attachments.createUpload(DEV, globId, { fileName: label }));
        const key = made.artifact.file?.key ?? '';
        objects.put(key, { size: 5, contentType: 'image/png' });
        await Promise.all([attachments.objectArrived(key), attachments.sweep(), attachments.refreshGlob(globId)]);
        expect(await versionsOf(label)).toEqual(['pending', 'stored']);
      }
    });

    it('does not expire a file stored between the sweep looking and writing', async () => {
      const made = unwrap(await attachments.createUpload(DEV, globId, { fileName: 'edge.png' }));
      const key = made.artifact.file?.key ?? '';
      let landed = false;
      const racing: FakeObjectStore = new FakeObjectStore();
      const head = racing.head.bind(racing);
      racing.head = async (k) => {
        const found = await head(k);
        if (!landed) {
          landed = true;
          objects.put(key, { size: 4, contentType: 'image/png' });
          await attachments.objectArrived(key);
        }
        return found;
      };
      const late = new AttachmentService({ store, notifier: { publish: () => undefined }, clock: { now: () => new Date(Date.now() + 3_600_000).toISOString() }, objects: racing, newId: () => 'unused' });
      await late.sweep();
      expect(await versionsOf('edge.png')).toEqual(['pending', 'stored']);
    });
  });
});
