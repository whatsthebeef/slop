import {
  DEFAULT_MAX_FILE_BYTES,
  DOWNLOAD_TTL_SECONDS,
  UPLOAD_TTL_SECONDS,
  cleanFileName,
  fileKey,
  objectProblem,
  resolveContentType,
  servedInline,
} from '../domain/attachment-file.js';
import type { AttachmentFile } from '../domain/attachment-file.js';
import { invalidInput, notFound, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { deleteObjectEffect } from '../domain/events.js';
import type { Artifact } from '../domain/knowledge.js';
import type { Glob } from '../domain/types.js';
import type { Clock, Notifier, ObjectInfo, ObjectStore, PresignedUpload, Store, Tx } from '../ports.js';
import { memberOf } from './access.js';
import { addArtifact } from './artifact-service.js';

export interface FileUpload {
  readonly artifact: Artifact;
  readonly upload: PresignedUpload;
  readonly expiresAt: string;
}

/** What the arrival of an object did: `orphaned` when no file owns the key (its deletion is queued), `ignored` otherwise when nothing applies. */
export type ArrivalOutcome = 'stored' | 'refused' | 'orphaned' | 'ignored';

/** The keys of the glob's file attachments whose objects may exist (not yet `missing`). */
export const fileKeysOf = async (tx: Tx, globId: string): Promise<string[]> =>
  (await tx.listArtifacts(globId, 'attachment')).flatMap((a) => (a.file === undefined || a.file === null ? [] : [a.file.key]));

/**
 * The latest version of the file attachment that owns `key`, read under the glob's artifact lock: it is read once to
 * learn the glob, the lock is taken, and it is read again, so what the caller decides on is what is committed.
 */
const ownerOf = async (tx: Tx, key: string): Promise<Artifact | null> => {
  const first = await tx.findFileArtifact(key);
  if (first === null) return null;
  await tx.lockGlobArtifacts(first.globId);
  return tx.findFileArtifact(key);
};

/** The glob a key was minted under (`boards/<board>/globs/<globId>/<uuid>`), for the outbox row of a key no artifact owns. */
const globOfKey = (key: string): string => key.split('/')[3] ?? '';

/**
 * File attachments: upload links, arrival of the object, and what happens when it never comes. The bytes never pass
 * through slop. Slop picks the key and bakes it into the presigned POST, so arrival is detected from storage (an object
 * event, or a `head` as the fallback on a glob read and in the sweep), never from the client. Each state change is a new
 * version of the attachment, so the latest version is the file's state.
 */
export class AttachmentService {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      notifier: Notifier;
      objects: ObjectStore;
      /** A random identifier for a new object key. */
      newId: () => string;
      /** The per-file limit in bytes (the board's setting; 10 MiB when unset). */
      maxBytes?: (boardId: number) => number;
      log?: (task: string, message: string) => void;
    },
  ) {}

  private limit(boardId: number): number {
    return this.deps.maxBytes?.(boardId) ?? DEFAULT_MAX_FILE_BYTES;
  }

  private plus(seconds: number): string {
    return new Date(Date.parse(this.deps.clock.now()) + seconds * 1000).toISOString();
  }

  /**
   * An upload link for a file on the glob, and its `pending` attachment. The label defaults to the file name. A label
   * that already holds a `missing` file is filled again (the same entry); one that holds anything else is refused.
   */
  async createUpload(
    email: string,
    globId: string,
    input: { readonly fileName: string; readonly contentType?: string | null; readonly label?: string | null },
  ): Promise<Result<FileUpload>> {
    const fileName = cleanFileName(input.fileName);
    if (fileName === '') return invalidInput('A file needs a name');
    const contentType = resolveContentType(fileName, input.contentType);
    if (contentType === null) return invalidInput(`${fileName}: this file type is not accepted`);
    const label = (input.label ?? '').trim() === '' ? fileName : (input.label ?? '').trim();
    const result = await this.deps.store.transaction(async (tx): Promise<Result<{ artifact: Artifact; upload: PresignedUpload; glob: Glob }>> => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      await tx.lockGlobArtifacts(globId);
      const existing = (await tx.listArtifacts(globId, 'attachment')).find((a) => a.label === label);
      if (existing !== undefined && existing.file?.state !== 'missing') return invalidInput(`${globId} already has an attachment labelled "${label}" (version ${String(existing.version)}); remove it or give this one another label`);
      const key = fileKey(glob.boardId, glob.id, this.deps.newId());
      const expiresAt = this.plus(UPLOAD_TTL_SECONDS);
      const upload = await this.deps.objects.presignUpload({
        key,
        maxBytes: this.limit(glob.boardId),
        contentTypes: [contentType],
        ttlSeconds: UPLOAD_TTL_SECONDS,
      });
      const file: AttachmentFile = { key, fileName, contentType, size: null, state: 'pending', expiresAt, reason: null };
      const artifact = await addArtifact(tx, this.deps.clock, glob, email, {
        kind: 'attachment',
        label,
        content: '',
        link: null,
        commitSha: null,
        runId: null,
        agentSetVersion: null,
        reviewStats: null,
        file,
      });
      return ok({ artifact, upload, glob });
    });
    if (!result.ok) return result;
    this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: result.value.glob.boardId, globId });
    return ok({ artifact: result.value.artifact, upload: result.value.upload, expiresAt: result.value.artifact.file?.expiresAt ?? '' });
  }

  /**
   * An object was created at `key` (the storage event). `info` is what the event carried; without it, or without a
   * type, the object is read with `head`. A pending file whose object passes the checks becomes `stored`; one that
   * fails them loses its object and becomes `missing` with the reason.
   */
  async objectArrived(key: string, info?: Partial<ObjectInfo>): Promise<ArrivalOutcome> {
    // An object no file owns (detached while its link was open, an earlier key of a refilled entry, a deleted glob's) goes.
    const orphaned = await this.deps.store.transaction(async (tx) => {
      if ((await ownerOf(tx, key)) !== null) return false;
      await tx.enqueueEffects([deleteObjectEffect(globOfKey(key), key)]);
      return true;
    });
    if (orphaned) return 'orphaned';
    const seen = info?.size !== undefined && info.contentType !== undefined ? { size: info.size, contentType: info.contentType } : await this.deps.objects.head(key);
    if (seen === null) return 'ignored';
    return this.settle(key, seen);
  }

  /** A pending file's object, as storage reports it: stored when it is fine, refused (and its deletion queued) when it isn't. */
  private async settle(key: string, seen: ObjectInfo): Promise<ArrivalOutcome> {
    const outcome = await this.deps.store.transaction(async (tx): Promise<{ outcome: ArrivalOutcome; glob: Glob | null }> => {
      const current = await ownerOf(tx, key);
      const file = current?.file;
      if (current === null || file === undefined || file === null || file.state !== 'pending') return { outcome: 'ignored', glob: null };
      const glob = await tx.getGlob(current.globId);
      if (glob === null) return { outcome: 'ignored', glob: null };
      const problem = objectProblem(file, seen, this.limit(glob.boardId));
      await this.append(tx, glob, current, problem === null ? { ...file, size: seen.size, state: 'stored' } : { ...file, size: seen.size, state: 'missing', reason: problem });
      if (problem !== null) await tx.enqueueEffects([deleteObjectEffect(glob.id, key)]);
      return { outcome: problem === null ? 'stored' : 'refused', glob };
    });
    if (outcome.glob === null) return outcome.outcome;
    this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: outcome.glob.boardId, globId: outcome.glob.id });
    return outcome.outcome;
  }

  /** A new version of the attachment carrying `file`, written as the one who made it. */
  private append(tx: Tx, glob: Glob, previous: Artifact, file: AttachmentFile): Promise<Artifact> {
    return addArtifact(tx, this.deps.clock, glob, previous.provenance.actor, {
      kind: 'attachment',
      label: previous.label,
      content: '',
      link: null,
      commitSha: null,
      runId: previous.provenance.runId,
      agentSetVersion: null,
      reviewStats: null,
      by: previous.provenance.by,
      file,
    });
  }

  /**
   * Looks at one pending file in storage: arrived (stored or refused), or past its expiry (missing). Not yet there and
   * not yet expired: left pending. The fallback for a lost event, and the sweep's step.
   */
  private async check(artifact: Artifact): Promise<ArrivalOutcome | 'expired' | 'waiting'> {
    const file = artifact.file;
    if (file === undefined || file === null || file.state !== 'pending') return 'ignored';
    const seen = await this.deps.objects.head(file.key);
    if (seen !== null) return this.settle(file.key, seen);
    if (Date.parse(file.expiresAt) > Date.parse(this.deps.clock.now())) return 'waiting';
    const expired = await this.deps.store.transaction(async (tx) => {
      const current = await ownerOf(tx, file.key);
      if (current?.file?.state !== 'pending') return null;
      const glob = await tx.getGlob(current.globId);
      if (glob === null) return null;
      await this.append(tx, glob, current, { ...current.file, state: 'missing', reason: null });
      return glob;
    });
    if (expired === null) return 'ignored';
    this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: expired.boardId, globId: expired.id });
    return 'expired';
  }

  /**
   * How long, in milliseconds, the glob's pending files can still arrive (until the last open link expires); 0 when none
   * is waiting. A sub's first run waits this long for its files. Looks in storage first, so an arrived file doesn't hold it.
   */
  async pendingFor(globId: string): Promise<number> {
    await this.refreshGlob(globId);
    const pending = await this.deps.store.transaction((tx) => tx.listPendingFileArtifacts(globId));
    const now = Date.parse(this.deps.clock.now());
    return pending.reduce((wait, a) => Math.max(wait, a.file === undefined || a.file === null ? 0 : Date.parse(a.file.expiresAt) - now), 0);
  }

  /** The fallback on a glob read: looks at the glob's pending files, so a lost storage event only delays detection. */
  async refreshGlob(globId: string): Promise<void> {
    const pending = await this.deps.store.transaction((tx) => tx.listPendingFileArtifacts(globId));
    for (const artifact of pending) await this.check(artifact).catch((e: unknown) => this.report(e));
  }

  /** The periodic sweep: every pending file is looked at. Returns how many it stored, refused and expired. */
  async sweep(): Promise<{ readonly stored: number; readonly refused: number; readonly expired: number }> {
    const pending = await this.deps.store.transaction((tx) => tx.listPendingFileArtifacts());
    const counts = { stored: 0, refused: 0, expired: 0 };
    for (const artifact of pending) {
      try {
        const outcome = await this.check(artifact);
        if (outcome === 'stored') counts.stored++;
        else if (outcome === 'refused') counts.refused++;
        else if (outcome === 'expired') counts.expired++;
      } catch (e) {
        this.report(e);
      }
    }
    return counts;
  }

  private report(error: unknown): void {
    this.deps.log?.('attachments', error instanceof Error ? error.message : String(error));
  }

  /** A download link (about 15 minutes) for a stored file; board members only. Minted per request, never stored. */
  async downloadUrl(email: string, globId: string, label: string): Promise<Result<{ url: string; fileName: string; contentType: string; expiresAt: string }>> {
    const found = await this.deps.store.transaction(async (tx): Promise<Result<AttachmentFile>> => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      const file = (await tx.listArtifacts(globId, 'attachment')).find((a) => a.label === label)?.file;
      if (file === undefined || file === null) return notFound(`${globId} has no file attachment "${label}"`);
      if (file.state !== 'stored') return invalidInput(`${file.fileName} is ${file.state}, not stored`);
      return ok(file);
    });
    if (!found.ok) return found;
    const file = found.value;
    const url = await this.deps.objects.presignDownload(file.key, DOWNLOAD_TTL_SECONDS, {
      fileName: file.fileName,
      disposition: servedInline(file.contentType) ? 'inline' : 'attachment',
    });
    return ok({ url, fileName: file.fileName, contentType: file.contentType, expiresAt: this.plus(DOWNLOAD_TTL_SECONDS) });
  }

  /** Removes a file attachment: its object's deletion is queued, and the entry is cleared (older versions stay as history). */
  async detach(email: string, globId: string, label: string): Promise<Result<null>> {
    const result = await this.deps.store.transaction(async (tx): Promise<Result<{ glob: Glob }>> => {
      const glob = await tx.getGlob(globId);
      if (glob === null) return notFound(`No glob ${globId}`);
      const actor = await memberOf(tx, email, glob.boardId);
      if (!actor.ok) return actor;
      await tx.lockGlobArtifacts(globId);
      const current = (await tx.listArtifacts(globId, 'attachment')).find((a) => a.label === label);
      if (current?.file === undefined || current.file === null) return notFound(`${globId} has no file attachment "${label}"`);
      // The object goes through the outbox, in this transaction: a crash or a storage error can't leave it behind.
      await tx.enqueueEffects([deleteObjectEffect(globId, current.file.key)]);
      await addArtifact(tx, this.deps.clock, glob, email, {
        kind: 'attachment',
        label,
        content: '',
        link: null,
        commitSha: null,
        runId: null,
        agentSetVersion: null,
        reviewStats: null,
      });
      return ok({ glob });
    });
    if (!result.ok) return result;
    this.deps.notifier.publish({ kind: 'glob.artifacts', boardId: result.value.glob.boardId, globId });
    return ok(null);
  }
}
