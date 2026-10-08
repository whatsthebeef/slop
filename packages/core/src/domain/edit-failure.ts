/** The parts of an API error body that decide how a refused glob edit is worded. */
export interface EditFailureBody {
  readonly code?: string;
  readonly message?: string;
  /** Present on a version conflict: the glob as it is now. */
  readonly current?: unknown;
}

export interface EditFailure {
  readonly message: string;
  /** The glob changed since the form was loaded; the person may reload it, keeping their edits visible. */
  readonly conflict: boolean;
}

/** Turns a refused glob edit into the text shown beside Save. */
export const describeEditFailure = (body: EditFailureBody | null | undefined): EditFailure => {
  if (body?.code === 'version_conflict' || body?.current !== undefined) {
    return {
      message: 'This glob changed while you were editing it. Reload the latest values to save again; your edits stay in the form.',
      conflict: true,
    };
  }
  const message = body?.message?.trim();
  return { message: message === undefined || message === '' ? 'The change was refused' : message, conflict: false };
};
