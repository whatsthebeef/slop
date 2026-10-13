/** Group names compare ignoring case, surrounding space and the separators `_`, `-` and whitespace. */
export const normaliseGroup = (s: string): string => s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

const MAX_GROUP_WORDS = 4;

/**
 * The group a split's parts share when the original has none: a short name from its title (the words before the first colon,
 * without a trailing "1/2"), lower-cased and hyphenated. An existing group with the same normalised name is reused as is.
 * Null when the title has no usable words.
 */
export const groupFromTitle = (title: string, existing: readonly string[]): string | null => {
  const head = (title.split(':')[0] ?? '').replace(/\b\d+\/\d+\b/g, ' ');
  const words = head.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  const name = words.slice(0, MAX_GROUP_WORDS).join('-');
  return existing.find((g) => normaliseGroup(g) === normaliseGroup(name)) ?? name;
};
