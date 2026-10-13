import { beforeEach, describe, expect, it } from 'vitest';
import { AttachmentService } from '../src/app/attachment-service.js';
import { GlobService } from '../src/app/glob-service.js';
import { missingFileNote, resolveContentType } from '../src/domain/attachment-file.js';
import type { AttachmentFile } from '../src/domain/attachment-file.js';
import type { Result } from '../src/domain/errors.js';
import type { Artifact } from '../src/domain/knowledge.js';
import { FakeObjectStore } from '../src/testing/fake-object-store.js';
import { MemoryStore, RecordingNotifier } from '../src/testing/memory-store.js';
import { glob as makeGlob } from './fixtures.js';

const START = '2026-10-13T12:00:00.000Z';
const DEV = 'dev@example.com';
const OUTSIDER = 'outsider@example.com';
const MAX = 1000;

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const errorCode = (r: Result<unknown>) => (r.ok ? 'ok' : r.error.code);

describe('file attachments', () => {
  let store: MemoryStore;
  let notifier: RecordingNotifier;
  let objects: FakeObjectStore;
  let service: AttachmentService;
  let now: string;
  let ids: number;
  let boardId: number;
  let globId: string;

  const advance = (ms: number) => {
    now = new Date(Date.parse(now) + ms).toISOString();
  };
  const latest = async (label: string): Promise<Artifact | undefined> =>
    (await store.transaction((tx) => tx.listArtifacts(globId, 'attachment'))).find((a) => a.label === label);
  const fileOf = async (label: string): Promise<AttachmentFile> => {
    const file = (await latest(label))?.file;
    if (file === undefined || file === null) throw new Error(`No file on ${label}`);
    return file;
  };
  /** The keys whose deletion is queued in the outbox (nothing is deleted until its executor runs). */
  const queuedDeletions = (): string[] => store.state.outbox.flatMap((e) => (e.kind === 'delete_object' ? [e.key] : []));
  const request = async (fileName = 'shot.png') => unwrap(await service.createUpload(DEV, globId, { fileName }));

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    objects = new FakeObjectStore();
    now = START;
    ids = 0;
    service = new AttachmentService({ store, clock: { now: () => now }, notifier, objects, newId: () => `uuid-${String(++ids)}`, maxBytes: () => MAX });
    boardId = await store.transaction(async (tx) => {
      for (const email of [DEV, OUTSIDER]) await tx.upsertUser({ email, name: email, active: true });
      const board = await tx.insertBoard({
        name: 'demo',
        repo: 'acme/app',
        baseBranch: 'main',
        timeZone: 'UTC',
        defaultRoutineOwner: null,
        environments: [],
        sensitivePaths: [],
      });
      await tx.upsertMember({ boardId: board.id, email: DEV, role: 'dev' });
      const g = makeGlob({ boardId: board.id });
      await tx.insertGlob(g, null);
      globId = g.id;
      return board.id;
    });
  });

  describe('createUpload', () => {
    it('adds a pending file under a key slop chose and asks storage for a limited, typed POST', async () => {
      const made = await request('Screen Shot.PNG');
      expect(made.artifact).toMatchObject({ kind: 'attachment', label: 'Screen Shot.PNG', content: '', link: null });
      expect(made.artifact.file).toEqual({
        key: `boards/${String(boardId)}/globs/${globId}/uuid-1`,
        fileName: 'Screen Shot.PNG',
        contentType: 'image/png',
        size: null,
        state: 'pending',
        expiresAt: '2026-10-13T12:15:00.000Z',
        reason: null,
      });
      expect(objects.uploads).toEqual([{ key: made.artifact.file?.key, maxBytes: MAX, contentTypes: ['image/png'], ttlSeconds: 900 }]);
      expect(made.expiresAt).toBe('2026-10-13T12:15:00.000Z');
      expect(notifier.hints).toContainEqual({ kind: 'glob.artifacts', boardId, globId });
    });

    it('uses the label when given, and refuses a type that is not accepted, a taken label and non-members', async () => {
      expect(unwrap(await service.createUpload(DEV, globId, { fileName: 'a.txt', label: 'Notes' })).artifact.label).toBe('Notes');
      expect(errorCode(await service.createUpload(DEV, globId, { fileName: 'b.txt', label: 'Notes' }))).toBe('invalid_input');
      expect(errorCode(await service.createUpload(DEV, globId, { fileName: 'tool.exe' }))).toBe('invalid_input');
      expect(errorCode(await service.createUpload(DEV, globId, { fileName: 'a.png', contentType: 'text/html' }))).toBe('invalid_input');
      expect(errorCode(await service.createUpload(OUTSIDER, globId, { fileName: 'a.png' }))).toBe('forbidden');
      expect(errorCode(await service.createUpload(DEV, 's9t9', { fileName: 'a.png' }))).toBe('not_found');
    });

    it('knows the accepted types by extension', () => {
      expect(['png', 'jpg', 'gif', 'webp', 'svg', 'pdf', 'txt', 'md', 'json', 'csv', 'log', 'zip'].map((e) => resolveContentType(`f.${e}`, null))).not.toContain(null);
      expect(resolveContentType('f.html', null)).toBeNull();
    });
  });

  describe('arrival', () => {
    it('marks the pending file stored when the object event arrives, with its size and type from a head', async () => {
      const made = await request();
      const key = made.artifact.file?.key ?? '';
      objects.put(key, { size: 400, contentType: 'image/png' });
      notifier.hints.length = 0;
      expect(await service.objectArrived(key)).toBe('stored');
      expect(await fileOf('shot.png')).toMatchObject({ state: 'stored', size: 400, reason: null });
      expect(notifier.hints).toContainEqual({ kind: 'glob.artifacts', boardId, globId });
      const versions = await store.transaction((tx) => tx.artifactVersions(globId, 'attachment', 'shot.png'));
      expect(versions.map((v) => v.file?.state)).toEqual(['pending', 'stored']);
    });

    it('takes size and type from the event when it carries them, without a head', async () => {
      const made = await request();
      expect(await service.objectArrived(made.artifact.file?.key ?? '', { size: 10, contentType: 'image/png' })).toBe('stored');
      expect(await fileOf('shot.png')).toMatchObject({ state: 'stored', size: 10 });
    });

    it('ignores an event for an object that is not there or a key no pending file has, and a repeated event', async () => {
      const made = await request();
      const key = made.artifact.file?.key ?? '';
      expect(await service.objectArrived(key)).toBe('ignored');
      objects.put(key, { size: 5, contentType: 'image/png' });
      expect(await service.objectArrived(key)).toBe('stored');
      expect(await service.objectArrived(key)).toBe('ignored');
      expect(queuedDeletions()).toEqual([]);
      expect(await store.transaction((tx) => tx.artifactVersions(globId, 'attachment', 'shot.png'))).toHaveLength(2);
    });

    it('queues the deletion of an object no file owns', async () => {
      expect(await service.objectArrived('boards/1/globs/s1t1/stray', { size: 3 })).toBe('orphaned');
      expect(store.state.outbox).toContainEqual({ kind: 'delete_object', globId: 's1t1', key: 'boards/1/globs/s1t1/stray' });
    });

    it('finds the object by head when reading the glob (a lost event only delays detection)', async () => {
      const made = await request();
      await service.refreshGlob(globId);
      expect((await fileOf('shot.png')).state).toBe('pending');
      objects.put(made.artifact.file?.key ?? '', { size: 20, contentType: 'image/png' });
      await service.refreshGlob(globId);
      expect(await fileOf('shot.png')).toMatchObject({ state: 'stored', size: 20 });
    });

    it('says how long pending files can still arrive, and nothing once they have arrived or expired', async () => {
      expect(await service.pendingFor(globId)).toBe(0);
      const made = await request();
      expect(await service.pendingFor(globId)).toBe(15 * 60_000);
      advance(60_000);
      expect(await service.pendingFor(globId)).toBe(14 * 60_000);
      objects.put(made.artifact.file?.key ?? '', { size: 20, contentType: 'image/png' });
      expect(await service.pendingFor(globId)).toBe(0);
      await request('later.png');
      advance(16 * 60_000);
      expect(await service.pendingFor(globId)).toBe(0);
      expect((await fileOf('later.png')).state).toBe('missing');
    });

    it('finds the object by head in the sweep', async () => {
      const made = await request();
      objects.put(made.artifact.file?.key ?? '', { size: 20, contentType: 'image/png' });
      expect(await service.sweep()).toEqual({ stored: 1, refused: 0, expired: 0 });
      expect((await fileOf('shot.png')).state).toBe('stored');
    });

    it.each([
      ['too big', { size: MAX + 1, contentType: 'image/png' }, 'bytes'],
      ['empty', { size: 0, contentType: 'image/png' }, 'bytes'],
      ['another type', { size: 10, contentType: 'application/pdf' }, 'announced'],
      ['a type that is not accepted', { size: 10, contentType: 'text/html' }, 'announced'],
    ])('deletes the object and marks the file missing with the reason when it is %s', async (_name, object, reason) => {
      const made = await request();
      const key = made.artifact.file?.key ?? '';
      objects.put(key, object);
      expect(await service.objectArrived(key)).toBe('refused');
      expect(queuedDeletions()).toEqual([key]);
      const file = await fileOf('shot.png');
      expect(file.state).toBe('missing');
      expect(file.reason).toContain(reason);
      expect(missingFileNote((await latest('shot.png')) as Artifact)).toContain('was not accepted');
    });
  });

  describe('expiry', () => {
    it('keeps a pending file waiting until its link expires, then marks it missing with a note', async () => {
      await request();
      advance(14 * 60_000);
      expect(await service.sweep()).toEqual({ stored: 0, refused: 0, expired: 0 });
      advance(2 * 60_000);
      expect(await service.sweep()).toEqual({ stored: 0, refused: 0, expired: 1 });
      const artifact = await latest('shot.png');
      expect(artifact?.file).toMatchObject({ state: 'missing', reason: null });
      expect(missingFileNote(artifact as Artifact)).toBe(`shot.png was never uploaded (from ${DEV}, ${artifact?.createdAt ?? ''}): upload it here.`);
      expect(await service.sweep()).toEqual({ stored: 0, refused: 0, expired: 0 });
    });

    it('still stores an object that landed before the check, even past expiry', async () => {
      const made = await request();
      objects.put(made.artifact.file?.key ?? '', { size: 1, contentType: 'image/png' });
      advance(60 * 60_000);
      expect(await service.sweep()).toEqual({ stored: 1, refused: 0, expired: 0 });
    });

    it('does not mark a file missing when it was stored between the look and the write', async () => {
      const made = await request();
      const key = made.artifact.file?.key ?? '';
      advance(60 * 60_000);
      // The object lands (and the event is handled) while the sweep is looking, after its head came back empty.
      let landed = false;
      const racing: FakeObjectStore = new FakeObjectStore();
      const head = racing.head.bind(racing);
      racing.head = async (k) => {
        const found = await head(k);
        if (!landed) {
          landed = true;
          objects.put(key, { size: 4, contentType: 'image/png' });
          expect(await service.objectArrived(key)).toBe('stored');
        }
        return found;
      };
      const sweeper = new AttachmentService({ store, clock: { now: () => now }, notifier, objects: racing, newId: () => 'x', maxBytes: () => MAX });
      expect(await sweeper.sweep()).toEqual({ stored: 0, refused: 0, expired: 0 });
      expect(await fileOf('shot.png')).toMatchObject({ state: 'stored', size: 4 });
      const versions = await store.transaction((tx) => tx.artifactVersions(globId, 'attachment', 'shot.png'));
      expect(versions.map((v) => v.file?.state)).toEqual(['pending', 'stored']);
    });

    it('has no note for stored or pending files', async () => {
      await request();
      expect(missingFileNote((await latest('shot.png')) as Artifact)).toBeNull();
    });
  });

  describe('manual upload', () => {
    it('fills the same entry of a missing file with a new key and a new link', async () => {
      const first = await request();
      advance(16 * 60_000);
      await service.sweep();
      const again = unwrap(await service.createUpload(DEV, globId, { fileName: 'shot.png' }));
      expect(again.artifact.label).toBe('shot.png');
      expect(again.artifact.file?.key).toBe(`boards/${String(boardId)}/globs/${globId}/uuid-2`);
      expect(again.artifact.file?.key).not.toBe(first.artifact.file?.key);
      expect(await fileOf('shot.png')).toMatchObject({ state: 'pending', reason: null });
      objects.put(again.artifact.file?.key ?? '', { size: 3, contentType: 'image/png' });
      expect(await service.objectArrived(again.artifact.file?.key ?? '')).toBe('stored');
      expect((await store.transaction((tx) => tx.listArtifacts(globId, 'attachment'))).filter((a) => a.label === 'shot.png')).toHaveLength(1);
      expect((await fileOf('shot.png')).state).toBe('stored');
      // The first key no longer leads anywhere: an object that lands there is removed.
      expect(await service.objectArrived(first.artifact.file?.key ?? '', { size: 3, contentType: 'image/png' })).toBe('orphaned');
      expect(queuedDeletions()).toEqual([first.artifact.file?.key]);
    });
  });

  describe('download', () => {
    it('mints a short-lived link per request for a stored file, inline for images and as a download for svg', async () => {
      const png = await request('a.png');
      const svg = await request('b.svg');
      for (const made of [png, svg]) objects.put(made.artifact.file?.key ?? '', { size: 9, contentType: made.artifact.file?.contentType ?? '' });
      await service.sweep();
      const a = unwrap(await service.downloadUrl(DEV, globId, 'a.png'));
      expect(a.url).toContain('?ttl=900');
      expect(a.expiresAt).toBe('2026-10-13T12:15:00.000Z');
      unwrap(await service.downloadUrl(DEV, globId, 'b.svg'));
      expect(objects.downloads.map((d) => d.disposition)).toEqual(['inline', 'attachment']);
    });

    it('is for board members only, and only once the file is stored', async () => {
      const made = await request('a.png');
      expect(errorCode(await service.downloadUrl(DEV, globId, 'a.png'))).toBe('invalid_input');
      objects.put(made.artifact.file?.key ?? '', { size: 9, contentType: 'image/png' });
      await service.sweep();
      expect(errorCode(await service.downloadUrl(OUTSIDER, globId, 'a.png'))).toBe('forbidden');
      expect(errorCode(await service.downloadUrl(DEV, globId, 'nope.png'))).toBe('not_found');
      expect(errorCode(await service.downloadUrl(DEV, 's9t9', 'a.png'))).toBe('not_found');
    });
  });

  describe('delete', () => {
    it('removes the object and clears the entry when a file is detached', async () => {
      const made = await request('a.png');
      const key = made.artifact.file?.key ?? '';
      objects.put(key, { size: 9, contentType: 'image/png' });
      await service.sweep();
      expect(errorCode(await service.detach(OUTSIDER, globId, 'a.png'))).toBe('forbidden');
      unwrap(await service.detach(DEV, globId, 'a.png'));
      expect(queuedDeletions()).toEqual([key]);
      expect(await latest('a.png')).toBeUndefined();
      expect(errorCode(await service.detach(DEV, globId, 'a.png'))).toBe('not_found');
      // The label is free again.
      expect(unwrap(await service.createUpload(DEV, globId, { fileName: 'a.png' })).artifact.version).toBe(4);
    });

    it('removes every object of a glob when the glob is deleted', async () => {
      const a = await request('a.png');
      const b = await request('b.txt');
      objects.put(a.artifact.file?.key ?? '', { size: 9, contentType: 'image/png' });
      await service.sweep();
      const globs = new GlobService({
        store,
        notifier,
        clock: { now: () => now },
        ids: { runId: () => 'run-1' },
        routines: { hasRoutine: () => Promise.resolve(true) },
      });
      const current = await store.transaction((tx) => tx.getGlob(globId));
      unwrap(await globs.delete(DEV, globId, current?.version ?? 0));
      expect(queuedDeletions().sort()).toEqual([a.artifact.file?.key ?? '', b.artifact.file?.key ?? ''].sort());
      expect(await store.transaction((tx) => tx.getGlob(globId))).toBeNull();
    });
  });
});
