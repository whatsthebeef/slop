import { DEFAULT_MAX_FILE_BYTES, resolveContentType } from '@slop/core';
import { api } from './api';

/** The extensions the picker offers; the server accepts the same set (`resolveContentType`). */
export const FILE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.svg,.pdf,.txt,.md,.json,.csv,.log,.zip';

const mib = (bytes: number) => `${String(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MiB`;

/** A clear message when the file can't be attached (too big, empty or a type slop doesn't take); null when it is fine. */
export const checkFile = (
  file: Pick<File, 'name' | 'size' | 'type'>,
  maxBytes: number = DEFAULT_MAX_FILE_BYTES,
): string | null => {
  if (file.size < 1) return `${file.name} is empty`;
  if (file.size > maxBytes)
    return `${file.name} is ${mib(file.size)}; files can be up to ${mib(maxBytes)}`;
  if (resolveContentType(file.name, file.type === '' ? null : file.type) === null) {
    return `${file.name} is a type slop can't store. Use an image, PDF, text, JSON, CSV, log or zip file`;
  }
  return null;
};

/** A pasted screenshot has a generic name; give it one a person can tell apart. */
export const nameForPasted = (
  file: Pick<File, 'name' | 'type'>,
  now: Date = new Date(),
): string => {
  if (file.name !== '' && file.name !== 'image.png') return file.name;
  const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 19);
  return `pasted-${stamp}.${extension}`;
};

/** The files on a paste or drop: pasting text yields none, so the field keeps its normal paste. */
export const filesOf = (
  items: Pick<DataTransfer, 'files'> | null | undefined,
  now?: Date,
): File[] =>
  Array.from(items?.files ?? []).map((file) => {
    const name = nameForPasted(file, now);
    return name === file.name ? file : new File([file], name, { type: file.type });
  });

const hasField = (fields: Readonly<Record<string, string>>, name: string) =>
  Object.keys(fields).some((k) => k.toLowerCase() === name.toLowerCase());

/** The multipart body of a presigned POST: S3 wants the policy's fields first and the file last. */
export const uploadForm = (
  fields: Readonly<Record<string, string>>,
  file: Blob,
  contentType: string,
): FormData => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  if (!hasField(fields, 'Content-Type')) form.append('Content-Type', contentType);
  form.append('file', file);
  return form;
};

/** The part of XMLHttpRequest an upload uses, so a test can stand in for it. */
export interface UploadRequest {
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null };
  onload: ((event: ProgressEvent) => void) | null;
  onerror: ((event: ProgressEvent) => void) | null;
  onabort: ((event: ProgressEvent) => void) | null;
  status: number;
  responseText: string;
  open(method: string, url: string): void;
  send(body: FormData): void;
  abort(): void;
}

/** What S3 says when it refuses a POST: the XML's message, or a plain one for the common causes. */
export const refusalMessage = (status: number, body: string): string => {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  if (code === 'EntityTooLarge') return 'The file is over the size limit';
  if (code === 'EntityTooSmall') return 'The file is empty';
  if (code === 'AccessDenied' || status === 403)
    return 'The upload link has expired or was refused; try again';
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
  return message ?? `The upload failed (${String(status)})`;
};

/** Posts the file straight to S3 with its presigned fields, reporting progress (0 to 1). Rejects with a message to show. */
export const postToStorage = (
  target: { readonly url: string; readonly fields: Readonly<Record<string, string>> },
  file: File,
  contentType: string,
  onProgress: (fraction: number) => void,
  request: UploadRequest = new XMLHttpRequest(),
): Promise<void> =>
  new Promise((resolve, reject) => {
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0)
        onProgress(Math.min(1, event.loaded / event.total));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(refusalMessage(request.status, request.responseText)));
      }
    };
    request.onerror = () =>
      reject(new Error('Could not reach storage. Check your connection and try again'));
    request.onabort = () => reject(new Error('The upload was cancelled'));
    request.open('POST', target.url);
    request.send(uploadForm(target.fields, file, contentType));
  });

export interface UploadOutcome {
  readonly label: string;
}

/**
 * Attaches one file to a glob: asks slop for an upload link (which creates the pending attachment, or refills the
 * `missing` one with `label`), then posts the bytes straight to storage. Slop sees the file arrive on its own; there is no
 * completion call.
 */
export const attachFile = async (
  globId: string,
  file: File,
  options: {
    readonly label?: string;
    readonly onProgress?: (fraction: number) => void;
    readonly request?: UploadRequest;
  } = {},
): Promise<UploadOutcome> => {
  const problem = checkFile(file);
  if (problem !== null) throw new Error(problem);
  const contentType =
    resolveContentType(file.name, file.type === '' ? null : file.type) ??
    'application/octet-stream';
  const link = await api.requestFileUpload(globId, {
    fileName: file.name,
    contentType,
    ...(options.label === undefined ? {} : { label: options.label }),
  });
  await postToStorage(
    link,
    file,
    contentType,
    options.onProgress ?? (() => undefined),
    options.request,
  );
  return { label: link.label };
};
