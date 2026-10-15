import { describe, expect, it } from 'vitest';
import { stripMarkdown, stripMarkdownLines } from '../src/lib/markdown-text';

describe('stripMarkdown', () => {
  it('removes bold, italics, inline code, links, headings, lists and quotes', () => {
    expect(stripMarkdown('**bold** and _it_ and `code` and ~~gone~~')).toBe('bold and it and code and gone');
    expect(stripMarkdown('[a link](https://x.test) ![img](y.png)')).toBe('a link img');
    expect(stripMarkdown('# Title\n- one\n- [x] two\n1. three\n> quote')).toBe('Title one two three quote');
  });

  it('keeps the text of a code fence and drops the fence lines', () => {
    expect(stripMarkdown('Run:\n```bash\nmake ship\n```')).toBe('Run: make ship');
  });

  it('leaves plain text and snake_case words alone and collapses whitespace', () => {
    expect(stripMarkdown('plain  text\nhere')).toBe('plain text here');
    expect(stripMarkdown('use my_var_name now')).toBe('use my_var_name now');
    expect(stripMarkdown('')).toBe('');
  });

  it('strips each line of a tooltip and keeps the line breaks', () => {
    expect(stripMarkdownLines('**a**\n`b`')).toBe('a\nb');
  });
});
