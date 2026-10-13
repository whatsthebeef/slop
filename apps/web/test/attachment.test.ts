import { describe, expect, it } from 'vitest';
import { fileStatus, hasThumbnail, sizeText } from '../src/lib/attachment';

const file = (over: Partial<NonNullable<Parameters<typeof fileStatus>[0]['file']>> = {}) => ({
  key: 'boards/1/globs/s1t1/abc',
  fileName: 'shot.png',
  contentType: 'image/png',
  size: 2048,
  state: 'stored' as const,
  expiresAt: '2026-10-13T15:00:00.000Z',
  reason: null,
  ...over,
});
const entry = (f: ReturnType<typeof file> | null) => ({
  file: f,
  createdAt: '2026-10-13T14:00:00.000Z',
  provenance: { by: 'agent', actor: 'claude-app' },
});

describe('sizeText', () => {
  it('reads sizes as a person does', () => {
    expect(sizeText(null)).toBe('');
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(12_345)).toBe('12.3 KB');
    expect(sizeText(1_400_000)).toBe('1.4 MB');
  });
});

describe('hasThumbnail', () => {
  it('shows stored raster images only', () => {
    expect(hasThumbnail(file())).toBe(true);
    expect(hasThumbnail(file({ contentType: 'image/png; charset=binary' }))).toBe(true);
    expect(hasThumbnail(file({ state: 'pending' }))).toBe(false);
    expect(hasThumbnail(file({ contentType: 'image/svg+xml' }))).toBe(false);
    expect(hasThumbnail(file({ contentType: 'application/pdf' }))).toBe(false);
  });
});

describe('fileStatus', () => {
  it('is null for an attachment without a file', () => {
    expect(fileStatus(entry(null))).toBeNull();
  });
  it('says a pending file is waiting', () => {
    expect(fileStatus(entry(file({ state: 'pending', size: null })))).toEqual({
      text: 'shot.png: waiting for upload',
      missing: false,
    });
  });
  it('carries the missing note, with the reason when the file was refused', () => {
    expect(fileStatus(entry(file({ state: 'missing', size: null })))).toEqual({
      text: 'shot.png was never uploaded (from claude-app, 2026-10-13T14:00:00.000Z): upload it here.',
      missing: true,
    });
    expect(fileStatus(entry(file({ state: 'missing', reason: 'too big' })))?.text).toContain(
      'was not accepted (too big)',
    );
  });
  it('gives a stored file its name and size', () => {
    expect(fileStatus(entry(file()))).toEqual({ text: 'shot.png · 2 KB', missing: false });
  });
});
