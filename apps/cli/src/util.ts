/** Parses JSON, or returns undefined when the text isn't JSON (callers report the raw text). */
export function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: undefined tells the caller to fall back.
    return undefined;
  }
}

const SANDBOX_CAUSE =
  /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|CERT_|ERR_TLS_|ERR_SSL_)/;

const SANDBOX_HINT =
  'inside a sandbox? the host must be in its network allowlist, and Node needs the proxy and CA: ' +
  'set HTTPS_PROXY and NODE_EXTRA_CA_CERTS (or NODE_USE_ENV_PROXY=1 / --use-system-ca)';

/**
 * A one-line description of a caught value, including fetch's underlying cause: its code and
 * message only (never argv or request bodies), with a sandbox hint for certificate and proxy errors.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
  const detail = [code, cause.message].filter((part) => part).join(': ');
  if (detail === '') return error.message;
  const hint = code !== undefined && SANDBOX_CAUSE.test(code) ? `; ${SANDBOX_HINT}` : '';
  return `${error.message} (${detail})${hint}`;
}
