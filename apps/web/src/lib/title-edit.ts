export type TitleDecision = { kind: 'empty' } | { kind: 'unchanged' } | { kind: 'save'; title: string };

/** What to do with the typed title: refuse an empty one, send nothing when it is unchanged, else save it trimmed. */
export const decideTitle = (current: string, typed: string): TitleDecision => {
  const title = typed.trim();
  if (title === '') return { kind: 'empty' };
  if (title === current) return { kind: 'unchanged' };
  return { kind: 'save', title };
};
