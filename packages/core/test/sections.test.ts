import { describe, expect, it } from 'vitest';
import { contextDiff, lineDiff } from '../src/domain/agent-set.js';
import { markdownHeadings, sectionText, spliceHeadings, spliceSection, splicePreview, withHeading } from '../src/domain/sections.js';

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

  it('keeps a trailing # that follows no whitespace as part of the heading (CommonMark closing hashes)', () => {
    expect(markdownHeadings('## C#\n\n## Closed ##\n\n### F# notes #\n').map((h) => h.text)).toEqual(['C#', 'Closed', 'F# notes']);
  });

  it('returns a section up to the next heading of the same or a higher level', () => {
    expect(sectionText(DOC, 'Test')).toBe('## Test\n\nRun vitest.\n\n### Watch\n\nUse --watch.\n\n```sh\n## not a heading\n```');
    expect(sectionText(DOC, '## lint')).toBe('## Lint\n\nRun eslint.');
    expect(sectionText(DOC, 'Missing')).toBeNull();
  });
});

describe('splicing a drafted section', () => {
  it('replaces a section with its nested subsections, up to the next heading of the same level', () => {
    expect(spliceSection(DOC, 'Test', '## Test\n\nRun vitest --reporter=dot.')).toBe(
      '# Title\n\nIntro\n\n## Test\n\nRun vitest --reporter=dot.\n\n## Lint\n\nRun eslint.\n',
    );
  });

  it('replaces only a nested subsection when that is the heading', () => {
    expect(spliceSection(DOC, '### watch', '### Watch\n\nUse vitest watch.\n')).toBe(
      '# Title\n\nIntro\n\n## Test\n\nRun vitest.\n\n### Watch\n\nUse vitest watch.\n\n## Lint\n\nRun eslint.\n',
    );
  });

  it('replaces the last section, keeping one trailing newline', () => {
    expect(spliceSection(DOC, 'Lint', '## Lint\n\nRun eslint --quiet.\n\n')).toBe(
      '# Title\n\nIntro\n\n## Test\n\nRun vitest.\n\n### Watch\n\nUse --watch.\n\n```sh\n## not a heading\n```\n\n## Lint\n\nRun eslint --quiet.\n',
    );
  });

  it('appends when the section is null or not a heading (including one only inside a code fence)', () => {
    const appended = '# A\n\nText\n\n## New\n\nBody\n';
    expect(spliceSection('# A\n\nText\n', null, '## New\n\nBody')).toBe(appended);
    expect(spliceSection('# A\n\nText\n\n\n', 'Missing', '## New\n\nBody')).toBe(appended);
    expect(spliceSection(DOC, 'not a heading', '## X')).toBe(`${DOC.trimEnd()}\n\n## X\n`);
    expect(spliceSection('', null, '### Rule\n\n- One')).toBe('### Rule\n\n- One\n');
  });

  it("never splices at a document's level-1 title when it has lower-level headings: the section is appended", () => {
    expect(spliceHeadings(DOC).map((h) => h.text)).toEqual(['Test', 'Watch', 'Lint']);
    expect(spliceSection(DOC, 'Title', '## Title notes\n\nMore')).toBe(`${DOC.trimEnd()}\n\n## Title notes\n\nMore\n`);
    // A text with only a level-1 heading can still have it replaced.
    expect(spliceSection('# Only\n\nOld\n', 'Only', '# Only\n\nNew')).toBe('# Only\n\nNew\n');
  });

  it('keeps CRLF line endings', () => {
    const crlf = '# A\r\n\r\n## B\r\n\r\nOld\r\n\r\n## C\r\n\r\nKeep\r\n';
    expect(spliceSection(crlf, 'B', '## B\n\nNew')).toBe('# A\r\n\r\n## B\r\n\r\nNew\r\n\r\n## C\r\n\r\nKeep\r\n');
    expect(spliceSection(crlf, null, '## D\n\nMore')).toBe('# A\r\n\r\n## B\r\n\r\nOld\r\n\r\n## C\r\n\r\nKeep\r\n\r\n## D\r\n\r\nMore\r\n');
  });

  it('adds a missing heading line to drafted content, at the existing level or the default', () => {
    expect(withHeading(DOC, 'Watch', 'Use --watch.', 2)).toBe('### Watch\n\nUse --watch.');
    expect(withHeading('', 'Testing', '- Rule', 3)).toBe('### Testing\n\n- Rule');
    expect(withHeading(DOC, 'Test', '## Test\n\nX', 2)).toBe('## Test\n\nX');
  });

  it('previews a splice as before, after and a line diff; a new document is the whole text', () => {
    const preview = splicePreview('# A\n\n## B\n\nOld\n', 'B', '## B\n\nNew');
    expect(preview.after).toBe('# A\n\n## B\n\nNew\n');
    expect(preview.diff.filter((l) => l.op !== 'same')).toEqual([
      { op: 'removed', text: 'Old' },
      { op: 'added', text: 'New' },
    ]);
    expect(splicePreview('', null, '# Doc\n\nBody', true).after).toBe('# Doc\n\nBody\n');
  });

  it('shows a diff with context, collapsing long unchanged runs', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'line ten');
    const diff = contextDiff(lineDiff(before, after), 2);
    expect(diff).toEqual([
      { op: 'skipped', count: 8 },
      { op: 'same', text: 'line 8' },
      { op: 'same', text: 'line 9' },
      { op: 'removed', text: 'line 10' },
      { op: 'added', text: 'line ten' },
      { op: 'same', text: 'line 11' },
      { op: 'same', text: 'line 12' },
      { op: 'skipped', count: 7 },
    ]);
    expect(contextDiff(lineDiff('a\n', 'a\n'))).toEqual([]);
  });
});
