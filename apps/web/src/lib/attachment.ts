/** The server's cap on an attachment's text (apps/server/src/http/knowledge.ts). */
export const ATTACHMENT_TEXT_MAX = 500_000;

export interface AttachmentDraft {
  readonly label: string;
  readonly mode: 'link' | 'text';
  readonly link: string;
  readonly text: string;
}

export type AttachmentCheck =
  | { readonly ok: true; readonly body: { label: string; text: string | null; link: string | null } }
  | { readonly ok: false; readonly message: string };

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** Validates the form the way the server will, so the person gets a clear message before posting. */
export const checkAttachment = (draft: AttachmentDraft): AttachmentCheck => {
  const label = draft.label.trim();
  if (label === '') return { ok: false, message: 'Give the attachment a label' };
  if (draft.mode === 'link') {
    const link = draft.link.trim();
    if (link === '') return { ok: false, message: 'Paste a link' };
    if (!isHttpUrl(link)) return { ok: false, message: 'The link must start with http:// or https://' };
    return { ok: true, body: { label, text: null, link } };
  }
  if (draft.text.trim() === '') return { ok: false, message: 'Paste some text or pick a text file' };
  if (draft.text.length > ATTACHMENT_TEXT_MAX) {
    return { ok: false, message: `The text is over ${String(ATTACHMENT_TEXT_MAX / 1000)} KB; attach a link instead` };
  }
  return { ok: true, body: { label, text: draft.text, link: null } };
};

/** Reads a picked or dropped file as text; refuses binary files (a NUL byte or invalid UTF-8) and oversized ones. */
export const readTextFile = async (
  file: Pick<File, 'name' | 'size' | 'arrayBuffer'>,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> => {
  if (file.size > ATTACHMENT_TEXT_MAX * 4) {
    return { ok: false, message: `${file.name} is too large; attach a link instead` };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0)) {
    return { ok: false, message: `${file.name} is not a text file. Images and PDFs can't be stored; attach a link instead` };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: `${file.name} is not a text file. Images and PDFs can't be stored; attach a link instead` };
  }
  if (text.length > ATTACHMENT_TEXT_MAX) {
    return { ok: false, message: `${file.name} is over ${String(ATTACHMENT_TEXT_MAX / 1000)} KB; attach a link instead` };
  }
  return { ok: true, text };
};
