/**
 * Markdown reduced to one plain line, for places that can't render it (card titles, the corner status, tooltips, `title=`
 * attributes, aria-labels): no `**`, backticks, `#`, link syntax or list markers; code text is kept; whitespace collapses.
 */
export const stripMarkdown = (text: string): string =>
  text
    .replace(/^ {0,3}(```|~~~)[^\n]*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** The same for multi-line text (a tooltip): each line is stripped on its own and the line breaks stay. */
export const stripMarkdownLines = (text: string): string =>
  text.split('\n').map(stripMarkdown).join('\n');

/** A person's first name from their email: `john.bower@x.com` is "John". Slop keeps no display names, so the address is all there is. */
export const firstNameOf = (email: string): string => {
  const first = (email.split('@')[0] ?? '').split(/[._+-]/)[0] ?? '';
  return first === '' ? email : first.charAt(0).toUpperCase() + first.slice(1);
};
