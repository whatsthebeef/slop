import { describe, expect, it } from 'vitest';
import { LOG_MAX_BYTES, LOG_MAX_LINES, tailOf } from '../src/build-logs.js';

describe('tailOf', () => {
  it('keeps the last 200 lines', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${String(i)}`);
    const out = tailOf(lines).split('\n');
    expect(out).toHaveLength(LOG_MAX_LINES);
    expect(out[0]).toBe('line 300');
    expect(out.at(-1)).toBe('line 499');
  });

  it('cuts from the front to fit 64 KB', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `${String(i)} ${'x'.repeat(1000)}`);
    const out = tailOf(lines);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(LOG_MAX_BYTES);
    expect(out.endsWith(`149 ${'x'.repeat(1000)}`)).toBe(true);
  });

  it('keeps the end of a single line longer than the bound', () => {
    const out = tailOf([`start ${'é'.repeat(LOG_MAX_BYTES)} end`]);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(LOG_MAX_BYTES);
    expect(out.endsWith(' end')).toBe(true);
    expect(out).not.toContain('�');
  });

  it('masks before cutting, so a block split by the cut is masked whole', () => {
    const lines = ['-----BEGIN PRIVATE KEY-----', ...Array.from({ length: 250 }, () => 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'), '-----END PRIVATE KEY-----', 'done'];
    const out = tailOf(lines, (t) => t.replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[masked]'));
    expect(out).toBe('[masked]\ndone');
  });
});
