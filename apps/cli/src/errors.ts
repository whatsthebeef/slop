/** A failure talking to slop or signing in: the CLI prints it and exits 1. */
export class SlopError extends Error {
  override readonly name = 'SlopError';
}

/** The command line was wrong: the CLI prints it with the usage and exits 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}
