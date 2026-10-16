/**
 * Commands in human-step text. A command a person has to run must sit in a copyable box on its own line, never inline in a
 * sentence: `explodeCommands` lifts every inline code span that starts a shell command out of its sentence into a fenced block, so
 * the Markdown view draws it as a code box with a copy button.
 */

/** A code span that starts a command: a known tool and an argument, or a `./` path. A lone tool name (`git`) is a word, not a command. */
const COMMAND = /^(?:(?:bash|sh|aws|gh|git|sstor|slop|pnpm|npm|export|unset|cd|curl)\s+\S|\.\/\S)/;

export const isCommandSpan = (code: string): boolean => COMMAND.test(code.trim());

const SPAN = /`([^`\n]+)`/g;

/** Inline command spans of `text` as their own fenced blocks; fenced blocks that are already there and all other text stay as they are. */
export const explodeCommands = (text: string): string => {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^ {0,3}(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line.replace(SPAN, (whole: string, code: string) => (isCommandSpan(code) ? `\n\n\`\`\`\n${code.trim()}\n\`\`\`\n\n` : whole));
    })
    .join('\n');
};
