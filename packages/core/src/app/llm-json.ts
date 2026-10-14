/**
 * Reading an LLM's JSON answer without a schema library (core has no dependencies): find the
 * outermost object, then narrow fields one by one.
 */
export const parseJson = (text: string): unknown => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return firstObject(text, start);
  }
};

/** The first balanced `{...}` from `start` (prose or a second object after it, braces inside strings ignored), else null. */
const firstObject = (text: string, start: number): unknown => {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
};

export const field = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  const found: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return found;
};

export const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);

export const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
