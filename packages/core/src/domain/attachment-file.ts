/**
 * File attachments: the bytes live in object storage, the `attachment` artifact carries what slop knows about them.
 * A file is `pending` from the moment its upload link is minted, `stored` once the object has arrived and passed the
 * checks, and `missing` when it never arrived (the link expired) or what arrived was refused.
 */
export const FILE_STATES = ['pending', 'stored', 'missing'] as const;
export type FileState = (typeof FILE_STATES)[number];

export interface AttachmentFile {
  /** The object key: `boards/<board>/globs/<globId>/<uuid>`, chosen by slop. */
  readonly key: string;
  readonly fileName: string;
  /** What the upload link was minted for; the stored object must carry the same type. */
  readonly contentType: string;
  /** Bytes, once the object has been seen. */
  readonly size: number | null;
  readonly state: FileState;
  /** When the upload link stops working; a file still pending then is `missing`. */
  readonly expiresAt: string;
  /** Why a `missing` file is missing (never uploaded, wrong size or type); null otherwise. */
  readonly reason: string | null;
}

/** 10 MiB: the board's per-file limit unless it sets another. */
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** How long an upload link works. */
export const UPLOAD_TTL_SECONDS = 15 * 60;
/** How long a download link works. */
export const DOWNLOAD_TTL_SECONDS = 15 * 60;

/** Extension → the one content type slop accepts for it. */
const TYPE_OF_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  log: 'text/plain',
  zip: 'application/zip',
};

export const ALLOWED_CONTENT_TYPES: readonly string[] = [...new Set(Object.values(TYPE_OF_EXTENSION))];

/** The media type without parameters, lower case (`Text/Plain; charset=utf-8` → `text/plain`). */
export const baseType = (contentType: string): string => (contentType.split(';')[0] ?? '').trim().toLowerCase();

export const isAllowedContentType = (contentType: string): boolean => ALLOWED_CONTENT_TYPES.includes(baseType(contentType));

/** Types a browser may show inline; everything else (svg included, since it can run script) is served as a download. */
const INLINE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];
export const servedInline = (contentType: string): boolean => INLINE_TYPES.includes(baseType(contentType));

/** The content type for a file: the one asked for when allowed, else the one its extension implies; null when neither. */
export const resolveContentType = (fileName: string, requested: string | null | undefined): string | null => {
  if (requested !== null && requested !== undefined && requested.trim() !== '') {
    return isAllowedContentType(requested) ? baseType(requested) : null;
  }
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  return TYPE_OF_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? null;
};

/** The file name without any directory part, control characters or surrounding space. */
export const cleanFileName = (fileName: string): string =>
  // eslint-disable-next-line no-control-regex
  (fileName.split(/[\\/]/).pop() ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();

export const fileKey = (boardId: number, globId: string, uuid: string): string => `boards/${String(boardId)}/globs/${globId}/${uuid}`;

/** Why an object that arrived is refused (null when it is fine). */
export const objectProblem = (
  file: Pick<AttachmentFile, 'contentType'>,
  object: { readonly size: number; readonly contentType: string },
  maxBytes: number,
): string | null => {
  if (object.size < 1 || object.size > maxBytes) return `The file is ${String(object.size)} bytes; files must be 1 to ${String(maxBytes)} bytes`;
  if (!isAllowedContentType(object.contentType) || baseType(object.contentType) !== baseType(file.contentType)) {
    return `The file's type ${baseType(object.contentType) || 'unknown'} is not the ${baseType(file.contentType)} it was announced as`;
  }
  return null;
};

/** The glob note for a file that never arrived: shown in the glob view and in `get_context`. Null for any other attachment. */
export const missingFileNote = (a: {
  readonly file?: AttachmentFile | null;
  readonly createdAt: string;
  readonly provenance: { readonly actor: string };
}): string | null => {
  const file = a.file;
  if (file === null || file === undefined || file.state !== 'missing') return null;
  const why = file.reason === null ? 'was never uploaded' : `was not accepted (${file.reason})`;
  return `${file.fileName} ${why} (from ${a.provenance.actor}, ${a.createdAt}): upload it here.`;
};
