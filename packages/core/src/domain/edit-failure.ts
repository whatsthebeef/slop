/** An error body as the API sends it (the fields the glob view needs). */
export interface EditErrorBody {
  readonly code?: string;
  readonly message?: string;
  readonly current?: unknown;
}

/** What to tell the person when a glob edit is refused. */
export interface EditFailure {
  /** `conflict`: the glob changed meanwhile, so the latest values can be reloaded. */
  readonly kind: 'conflict' | 'refused';
  readonly message: string;
}

/** Turns an error response from the glob update endpoint into words for the edit form. */
export const describeEditFailure = (body: EditErrorBody | null | undefined, globId: string): EditFailure => {
  if (body?.code === 'version_conflict' || body?.current !== undefined) {
    return { kind: 'conflict', message: `${globId} changed meanwhile. Your edits are kept; reload to see the latest values.` };
  }
  const message = body?.message?.trim();
  return { kind: 'refused', message: message === undefined || message === '' ? 'The change could not be saved' : message };
};
