import { lineDiff } from './agent-set.js';
import type { DiffLine } from './agent-set.js';

/**
 * Markdown sections, for routing and drafting KB items against one heading of a document or
 * agent file. Headings inside fenced code blocks are ignored.
 */
export interface Heading {
  /** 1 for `#`, 2 for `##`, and so on. */
  readonly level: number;
  readonly text: string;
  /** The heading's line index. */
  readonly line: number;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export const markdownHeadings = (markdown: string): Heading[] => {
  const headings: Heading[] = [];
  let fenced = false;
  markdown.split(/\r?\n/).forEach((line, index) => {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) return;
    const match = HEADING.exec(line);
    if (match !== null) headings.push({ level: match[1]?.length ?? 1, text: (match[2] ?? '').trim(), line: index });
  });
  return headings;
};

const sameHeading = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The section under `heading` (its heading line to the next heading of the same or a higher level), or null. */
export const sectionText = (markdown: string, heading: string): string | null => {
  const headings = markdownHeadings(markdown);
  const index = headings.findIndex((h) => sameHeading(h.text, heading.replace(/^#+\s*/, '')));
  const found = headings[index];
  if (found === undefined) return null;
  const next = headings.slice(index + 1).find((h) => h.level <= found.level);
  const lines = markdown.split(/\r?\n/);
  return lines.slice(found.line, next?.line ?? lines.length).join('\n').trim();
};

const firstHeading = (content: string): Heading | undefined => markdownHeadings(content)[0];

/**
 * `text` with one section replaced by `content` (its heading line through to the next heading of
 * the same or a higher level, so nested subsections go with it), or with `content` appended as a
 * new section when `section` is null or not a heading of `text`. Keeps the text's line endings.
 */
export const spliceSection = (text: string, section: string | null, content: string): string => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = content.trim().split(/\r?\n/);
  const lines = text.split(/\r?\n/);
  const headings = markdownHeadings(text);
  const index = section === null ? -1 : headings.findIndex((h) => sameHeading(h.text, section.replace(/^#+\s*/, '')));
  const found = headings[index];
  if (found === undefined) {
    if (text.trim() === '') return body.join(eol) + eol;
    return [text.trimEnd(), '', ...body].join(eol) + eol;
  }
  const next = headings.slice(index + 1).find((h) => h.level <= found.level);
  const before = lines.slice(0, found.line);
  if (next === undefined) return [...before, ...body].join(eol) + eol;
  // A blank line keeps the next heading apart from the new section.
  return [...before, ...body, '', ...lines.slice(next.line)].join(eol);
};

/** A section's heading line, added to drafted content that starts without one. */
export const withHeading = (text: string, section: string, content: string, defaultLevel: number): string => {
  const trimmed = content.trim();
  if (firstHeading(trimmed)?.line === 0) return trimmed;
  const existing = markdownHeadings(text).find((h) => sameHeading(h.text, section));
  return `${'#'.repeat(existing?.level ?? defaultLevel)} ${section}\n\n${trimmed}`;
};

/** A drafted section spliced into its target: the text before and after, and the line diff between them. */
export interface SplicePreview {
  readonly before: string;
  readonly after: string;
  readonly diff: DiffLine[];
}

/** What approving a draft would do to `before`; a new document's draft (`whole`) is the whole text. */
export const splicePreview = (before: string, section: string | null, content: string, whole = false): SplicePreview => {
  const after = whole ? `${content.trim()}\n` : spliceSection(before, section, content);
  return { before, after, diff: lineDiff(before, after) };
};
