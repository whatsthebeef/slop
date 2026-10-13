import { describe, expect, it } from 'vitest';
import { ATTACHMENT_TEXT_MAX, attachmentBody } from '../src/http/knowledge.js';

describe('attachment body', () => {
  it('accepts a link or text', () => {
    expect(attachmentBody.safeParse({ label: 'a', link: 'https://x.y' }).success).toBe(true);
    expect(attachmentBody.safeParse({ label: 'a', text: 'hi' }).success).toBe(true);
  });
  it('enforces the text size limit', () => {
    expect(attachmentBody.safeParse({ label: 'a', text: 'x'.repeat(ATTACHMENT_TEXT_MAX) }).success).toBe(true);
    expect(attachmentBody.safeParse({ label: 'a', text: 'x'.repeat(ATTACHMENT_TEXT_MAX + 1) }).success).toBe(false);
  });
});
