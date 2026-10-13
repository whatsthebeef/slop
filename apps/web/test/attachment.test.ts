import { describe, expect, it } from 'vitest';
import { ATTACHMENT_TEXT_MAX, checkAttachment, readTextFile } from '../src/lib/attachment';

const file = (name: string, bytes: Uint8Array) => ({ name, size: bytes.length, arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer) });
const enc = (s: string) => new TextEncoder().encode(s);

describe('checkAttachment', () => {
  it('requires a label', () => {
    expect(checkAttachment({ label: ' ', mode: 'link', link: 'https://a.b', text: '' })).toEqual({ ok: false, message: 'Give the attachment a label' });
  });
  it('builds the body for a link', () => {
    expect(checkAttachment({ label: ' Spec ', mode: 'link', link: ' https://a.b/c ', text: 'ignored' })).toEqual({
      ok: true,
      body: { label: 'Spec', text: null, link: 'https://a.b/c' },
    });
  });
  it('refuses an empty or non-http link', () => {
    expect(checkAttachment({ label: 'x', mode: 'link', link: '', text: '' }).ok).toBe(false);
    expect(checkAttachment({ label: 'x', mode: 'link', link: 'ftp://a.b', text: '' }).ok).toBe(false);
    expect(checkAttachment({ label: 'x', mode: 'link', link: 'nope', text: '' }).ok).toBe(false);
  });
  it('builds the body for pasted text', () => {
    expect(checkAttachment({ label: 'Notes', mode: 'text', link: '', text: 'hello' })).toEqual({
      ok: true,
      body: { label: 'Notes', text: 'hello', link: null },
    });
  });
  it('refuses empty and oversized text', () => {
    expect(checkAttachment({ label: 'x', mode: 'text', link: '', text: '  ' }).ok).toBe(false);
    expect(checkAttachment({ label: 'x', mode: 'text', link: '', text: 'a'.repeat(ATTACHMENT_TEXT_MAX + 1) }).ok).toBe(false);
  });
});

describe('readTextFile', () => {
  it('reads a text file', async () => {
    expect(await readTextFile(file('a.md', enc('# hi')))).toEqual({ ok: true, text: '# hi' });
  });
  it('refuses binary content', async () => {
    const r = await readTextFile(file('a.png', new Uint8Array([0x89, 0x50, 0, 1])));
    expect(r.ok).toBe(false);
    expect(await readTextFile(file('b.bin', new Uint8Array([0xff, 0xfe, 0xfd])))).toMatchObject({ ok: false });
  });
  it('refuses an oversized file', async () => {
    expect(await readTextFile(file('big.txt', enc('a'.repeat(ATTACHMENT_TEXT_MAX + 1))))).toMatchObject({ ok: false });
  });
});
