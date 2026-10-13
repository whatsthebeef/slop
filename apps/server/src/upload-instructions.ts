import type { FileUpload } from '@slop/core';

/** At most this many files on one `create_glob`. */
export const MAX_CREATE_FILES = 10;

/** The rule every tool that takes files repeats, so an agent never sends bytes through a tool call. */
export const NEVER_INLINE_FILES =
  "Never put file content in a tool argument. Upload with the returned curl command from your shell or code sandbox. In the Claude app, the slop-attach skill's script does this.";

/** The line that follows the upload commands: the next step is in what the agent just read. */
export const UPLOAD_NEXT = "Run each curl command now with the file's path. Slop detects the upload; no further call is needed.";

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** The exact command that uploads a file with the presigned POST: every policy field first, the file last, `<path>` to fill in. */
export const curlFor = (upload: { readonly url: string; readonly fields: Readonly<Record<string, string>> }): string =>
  [
    'curl -sS -f -X POST',
    ...Object.entries(upload.fields).map(([name, value]) => `-F ${quote(`${name}=${value}`)}`),
    '-F file=@<path>',
    quote(upload.url),
  ].join(' ');

/** What the reply carries for one file. */
export const uploadView = (made: FileUpload) => ({
  fileName: made.artifact.file?.fileName ?? made.artifact.label,
  label: made.artifact.label,
  attachmentId: made.artifact.id,
  url: made.upload.url,
  fields: made.upload.fields,
  expiresAt: made.expiresAt,
  curl: curlFor(made.upload),
});
