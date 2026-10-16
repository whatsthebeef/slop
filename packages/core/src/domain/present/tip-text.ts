/** A tooltip line as a sentence: it ends in a full stop unless it already ends in `.`, `!`, `?`, `…` or `:`; a blank line is dropped. */
export const sentence = (line: string): string => {
  const text = line.trimEnd();
  if (text === '') return '';
  return /[.!?…:]$/.test(text) ? text : `${text}.`;
};

/** Tooltip lines joined by newlines, each a sentence, so one line never runs into the next. */
export const tipLines = (lines: readonly string[]): string =>
  lines
    .flatMap((l) => l.split('\n'))
    .map(sentence)
    .filter((l) => l !== '')
    .join('\n');
