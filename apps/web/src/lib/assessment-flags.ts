/** The flag lines of a rule-based assessment's Markdown (its "### Flags" list); none for "None." or when there is no such section. */
export const flagsOf = (markdown: string): string[] => {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === '### Flags');
  if (start < 0) return [];
  const flags: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    const match = /^- (.+)$/.exec(line.trim());
    if (match?.[1] !== undefined) flags.push(match[1]);
  }
  return flags;
};
