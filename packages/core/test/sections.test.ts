import { describe, expect, it } from 'vitest';
import { markdownHeadings, sectionText } from '../src/domain/sections.js';

const DOC = '# Title\n\nIntro\n\n## Test\n\nRun vitest.\n\n### Watch\n\nUse --watch.\n\n```sh\n## not a heading\n```\n\n## Lint\n\nRun eslint.\n';

describe('markdown sections', () => {
  it('lists headings with their levels, ignoring fenced code', () => {
    expect(markdownHeadings(DOC).map((h) => [h.level, h.text])).toEqual([
      [1, 'Title'],
      [2, 'Test'],
      [3, 'Watch'],
      [2, 'Lint'],
    ]);
  });

  it('returns a section up to the next heading of the same or a higher level', () => {
    expect(sectionText(DOC, 'Test')).toBe('## Test\n\nRun vitest.\n\n### Watch\n\nUse --watch.\n\n```sh\n## not a heading\n```');
    expect(sectionText(DOC, '## lint')).toBe('## Lint\n\nRun eslint.');
    expect(sectionText(DOC, 'Missing')).toBeNull();
  });
});
