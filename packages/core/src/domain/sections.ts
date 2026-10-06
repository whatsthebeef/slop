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
