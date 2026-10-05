/** The fetch the CLI uses; tests inject a fake. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const HTTP_TIMEOUT_MS = 60_000;
