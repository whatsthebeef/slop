import { describe, expect, it } from 'vitest';
import { attachCommand, type AttachDeps } from '../src/attach.js';
import { SlopError, UsageError } from '../src/errors.js';

function setup(states: string[], uploadStatus = 204) {
  const rest: { method: string; path: string; body: unknown }[] = [];
  const posts: { url: string; form: FormData }[] = [];
  const logs: string[] = [];
  let clock = 0;
  let polls = 0;
  const deps: AttachDeps = {
    client: {
      call: () => Promise.resolve({ file: { state: states[Math.min(polls++, states.length - 1)] } }),
      rest: (method, path, body) => {
        rest.push({ method, path, body });
        return Promise.resolve({ attachmentId: 'a1', label: 'shot.png', url: 'https://bucket.test/', fields: { key: 'k', 'Content-Type': 'image/png' } });
      },
    },
    fetch: (url, init) => {
      posts.push({ url, form: init?.body as FormData });
      return Promise.resolve(new Response(uploadStatus === 204 ? null : '', { status: uploadStatus }));
    },
    readBytes: (path) => (path.endsWith('.png') ? Promise.resolve(new Uint8Array([1, 2, 3])) : Promise.reject(new Error('ENOENT'))),
    stdout: () => undefined,
    log: (m) => logs.push(m),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  };
  return { deps, rest, posts, logs };
}

describe('slop attach', () => {
  it('requests a link, posts fields then the file, and waits for stored', async () => {
    const { deps, rest, posts, logs } = setup(['pending', 'stored']);
    await attachCommand(['s1t4', 'dir/shot.png', '--label', 'shot.png'], deps);
    expect(rest).toEqual([{ method: 'POST', path: '/api/globs/s1t4/attachment-files', body: { fileName: 'shot.png', label: 'shot.png' } }]);
    expect([...(posts[0]?.form.keys() ?? [])]).toEqual(['key', 'Content-Type', 'file']);
    expect(logs).toEqual(['slop: attached dir/shot.png to s1t4']);
  });

  it('fails when slop marks the file missing or the upload is refused', async () => {
    await expect(attachCommand(['s1t4', 'a.png'], setup(['missing']).deps)).rejects.toThrow(SlopError);
    await expect(attachCommand(['s1t4', 'a.png'], setup(['stored'], 403).deps)).rejects.toThrow(/did not arrive/);
  });

  it('gives up waiting after the timeout', async () => {
    const { deps, logs } = setup(['pending']);
    await expect(attachCommand(['s1t4', 'a.png'], deps)).rejects.toThrow(SlopError);
    expect(logs[0]).toContain('has not seen it yet');
  });

  it('rejects bad usage and unreadable files', async () => {
    const { deps } = setup(['stored']);
    await expect(attachCommand([], deps)).rejects.toThrow(UsageError);
    await expect(attachCommand(['s1t4'], deps)).rejects.toThrow(UsageError);
    await expect(attachCommand(['s1t4', 'a.png', 'b.png', '--label', 'x'], deps)).rejects.toThrow(UsageError);
    await expect(attachCommand(['s1t4', 'a.txt'], deps)).rejects.toThrow(/could not read/);
  });
});
