/** Parses JSON, or returns undefined when the text isn't JSON (callers report the raw text). */
export function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: undefined tells the caller to fall back.
    return undefined;
  }
}

/** A one-line description of a caught value, including fetch's underlying cause. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.cause instanceof Error
      ? `${error.message} (${error.cause.message})`
      : error.message;
  }
  return String(error);
}
