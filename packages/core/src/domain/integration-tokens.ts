/**
 * A board's integration token (spec, Inbox and ingest): the credential an outside script (the Meet notes Apps Script)
 * uses to add inbox items to one board. Only the hash of the secret is stored; the secret is shown once, when created.
 */
export interface IntegrationToken {
  readonly id: number;
  readonly boardId: number;
  /** SHA-256 of the secret, as hex. */
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly revokedAt: string | null;
}

/** What a member sees of a board's token: that one exists and when it was made, never the secret. */
export interface IntegrationTokenStatus {
  readonly active: boolean;
  readonly createdAt: string | null;
}
