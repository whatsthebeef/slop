import { HTTP_TIMEOUT_MS, type Fetch } from './http.js';
import { describeError } from './util.js';

const DOC_URL = /https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/g;

/** The ids of the Google Docs a text links to, each once, in the order found. */
export function docIds(text: string): string[] {
  return [...new Set([...text.matchAll(DOC_URL)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])))];
}

export type DocResult =
  | { readonly ok: true; readonly id: string; readonly title: string; readonly text: string; readonly modified: string | undefined }
  | { readonly ok: false; readonly id: string; readonly reason: string };

/** Fetches a Google Doc as plain text through Drive's export, with a bearer token from the environment. */
export async function fetchDoc(id: string, token: string, fetch: Fetch): Promise<DocResult> {
  const call = async (path: string): Promise<Response> =>
    fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  try {
    const exported = await call('/export?mimeType=text%2Fplain');
    if (exported.status !== 200) return { ok: false, id, reason: `Drive answered ${String(exported.status)}` };
    const text = (await exported.text()).trim();
    if (text === '') return { ok: false, id, reason: 'the document is empty' };
    let title = id;
    let modified: string | undefined;
    const meta = await call('?fields=name,modifiedTime');
    if (meta.status === 200) {
      const body: unknown = await meta.json().catch(() => null);
      if (typeof body === 'object' && body !== null) {
        if ('name' in body && typeof body.name === 'string' && body.name !== '') title = body.name;
        if ('modifiedTime' in body && typeof body.modifiedTime === 'string') modified = body.modifiedTime;
      }
    }
    return { ok: true, id, title, text, modified };
  } catch (error) {
    return { ok: false, id, reason: describeError(error) };
  }
}
