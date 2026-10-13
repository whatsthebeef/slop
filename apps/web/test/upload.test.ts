import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachFile,
  checkFile,
  filesOf,
  nameForPasted,
  postToStorage,
  refusalMessage,
  uploadForm,
} from '../src/lib/upload';
import type { UploadRequest } from '../src/lib/upload';

afterEach(() => vi.unstubAllGlobals());

const file = (name: string, size = 10, type = '') => {
  const f = new File([new Uint8Array(Math.min(size, 10))], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

class FakeRequest implements UploadRequest {
  upload: UploadRequest['upload'] = { onprogress: null };
  onload: ((event: ProgressEvent) => void) | null = null;
  onerror: ((event: ProgressEvent) => void) | null = null;
  onabort: ((event: ProgressEvent) => void) | null = null;
  status = 204;
  responseText = '';
  opened: [string, string] | null = null;
  sent: FormData | null = null;
  open(method: string, url: string) {
    this.opened = [method, url];
  }
  send(body: FormData) {
    this.sent = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
    queueMicrotask(() => this.onload?.({} as ProgressEvent));
  }
  abort() {
    this.onabort?.({} as ProgressEvent);
  }
}

describe('checkFile', () => {
  it('accepts images, pdfs and text files', () => {
    expect(checkFile(file('a.png', 10, 'image/png'))).toBeNull();
    expect(checkFile(file('a.pdf'))).toBeNull();
    expect(checkFile(file('notes.md'))).toBeNull();
  });
  it('refuses a file that is too big, empty or of another type', () => {
    expect(checkFile(file('big.png', 11 * 1024 * 1024))).toMatch(/up to 10 MiB/);
    expect(checkFile(file('big.png', 3 * 1024 * 1024, 'image/png'), 2 * 1024 * 1024)).toBe(
      'big.png is 3 MiB; files can be up to 2 MiB',
    );
    expect(checkFile(file('empty.txt', 0))).toBe('empty.txt is empty');
    expect(checkFile(file('run.exe'))).toMatch(/type slop can't store/);
  });
});

describe('pasted files', () => {
  it('names a clipboard screenshot by time, and keeps real names', () => {
    const now = new Date('2026-10-13T14:05:09.000Z');
    expect(nameForPasted({ name: 'image.png', type: 'image/png' }, now)).toBe(
      'pasted-2026-10-13-14-05-09.png',
    );
    expect(nameForPasted({ name: '', type: 'image/jpeg' }, now)).toBe(
      'pasted-2026-10-13-14-05-09.jpg',
    );
    expect(nameForPasted({ name: 'report.pdf', type: 'application/pdf' }, now)).toBe('report.pdf');
  });
  it('yields no files for a text paste', () => {
    expect(filesOf({ files: [] as unknown as FileList })).toEqual([]);
    expect(filesOf(null)).toEqual([]);
  });
  it('renames a pasted image', () => {
    const pasted = new File(['x'], 'image.png', { type: 'image/png' });
    const [out] = filesOf(
      { files: [pasted] as unknown as FileList },
      new Date('2026-10-13T14:05:09.000Z'),
    );
    expect(out?.name).toBe('pasted-2026-10-13-14-05-09.png');
    expect(out?.type).toBe('image/png');
  });
});

describe('uploadForm', () => {
  it('puts the policy fields first and the file last', () => {
    const form = uploadForm({ key: 'k', policy: 'p' }, new Blob(['x']), 'image/png');
    expect([...form.keys()]).toEqual(['key', 'policy', 'Content-Type', 'file']);
    expect(form.get('Content-Type')).toBe('image/png');
  });
  it('keeps a Content-Type the policy already fixed', () => {
    const form = uploadForm(
      { 'Content-Type': 'image/png', key: 'k' },
      new Blob(['x']),
      'image/png',
    );
    expect(form.getAll('Content-Type')).toEqual(['image/png']);
  });
});

describe('postToStorage', () => {
  it('posts to the link and reports progress', async () => {
    const request = new FakeRequest();
    const progress: number[] = [];
    await postToStorage(
      { url: 'https://s3.example/bucket', fields: { key: 'k' } },
      file('a.png'),
      'image/png',
      (p) => progress.push(p),
      request,
    );
    expect(request.opened).toEqual(['POST', 'https://s3.example/bucket']);
    expect(request.sent?.get('key')).toBe('k');
    expect(progress).toEqual([0.5, 1]);
  });
  it('rejects with a readable message when storage refuses', async () => {
    const request = new FakeRequest();
    request.status = 400;
    request.responseText = '<Error><Code>EntityTooLarge</Code></Error>';
    await expect(
      postToStorage({ url: 'u', fields: {} }, file('a.png'), 'image/png', () => undefined, request),
    ).rejects.toThrow('over the size limit');
  });
  it('rejects when storage cannot be reached', async () => {
    const request = new FakeRequest();
    request.send = () => queueMicrotask(() => request.onerror?.({} as ProgressEvent));
    await expect(
      postToStorage({ url: 'u', fields: {} }, file('a.png'), 'image/png', () => undefined, request),
    ).rejects.toThrow('Could not reach storage');
  });
});

describe('refusalMessage', () => {
  it('explains the common refusals', () => {
    expect(refusalMessage(403, '')).toMatch(/expired/);
    expect(refusalMessage(400, '<Code>EntityTooSmall</Code>')).toBe('The file is empty');
    expect(refusalMessage(400, '<Message>Bad policy</Message>')).toBe('Bad policy');
    expect(refusalMessage(500, '')).toBe('The upload failed (500)');
  });
});

describe('attachFile', () => {
  const link = {
    attachmentId: 1,
    label: 'shot.png',
    file: {},
    url: 'https://s3.example/b',
    fields: { key: 'boards/1/globs/s1t1/x' },
    expiresAt: '2026-10-13T15:00:00.000Z',
  };

  it('asks slop for a link, then posts the bytes to storage', async () => {
    const calls: { path: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', (path: string, init: { body: string }) => {
      calls.push({ path, body: JSON.parse(init.body) });
      return Promise.resolve(Response.json(link, { status: 201 }));
    });
    const request = new FakeRequest();
    const outcome = await attachFile('s1t1', file('shot.png', 10, 'image/png'), { request });
    expect(outcome).toEqual({ label: 'shot.png' });
    expect(calls).toEqual([
      {
        path: '/api/globs/s1t1/attachment-files',
        body: { fileName: 'shot.png', contentType: 'image/png' },
      },
    ]);
    expect(request.sent?.get('key')).toBe('boards/1/globs/s1t1/x');
  });

  it('sends the label of the missing file it refills', async () => {
    let sent: unknown;
    vi.stubGlobal('fetch', (_path: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return Promise.resolve(Response.json(link, { status: 201 }));
    });
    await attachFile('s1t1', file('shot.png', 10, 'image/png'), {
      label: 'Screenshot',
      request: new FakeRequest(),
    });
    expect(sent).toMatchObject({ label: 'Screenshot' });
  });

  it('refuses a bad file without asking slop', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(attachFile('s1t1', file('run.exe'))).rejects.toThrow(/can't store/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes on slop refusing the link', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        Response.json(
          { code: 'invalid_input', message: 's1t1 already has an attachment labelled "a"' },
          { status: 422 },
        ),
      ),
    );
    await expect(
      attachFile('s1t1', file('a.png', 10, 'image/png'), { request: new FakeRequest() }),
    ).rejects.toThrow('already has an attachment');
  });
});
