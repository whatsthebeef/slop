import { randomBytes } from 'node:crypto';
import type { SignedLinks } from '../signed-links.js';

const TTL_SECONDS = 600;
const purpose = (nonce: string, returnTo: string): string => `board-sign-in:${nonce}:${returnTo}`;

/**
 * A same-origin relative path that is safe to redirect to after sign-in: it starts with a single
 * `/`, and has no backslash, control character or scheme/host form (`//evil.com`, `/\\evil.com`,
 * `https://evil.com`). Anything else is `/`.
 */
export const safeReturnPath = (value: string | undefined | null): string => {
  if (typeof value !== 'string' || value.length > 2000) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  // Backslashes and control characters are exactly what this refuses.
  // eslint-disable-next-line no-control-regex
  if (/[\\\x00-\x1f\x7f]/.test(value)) return '/';
  return value;
};

/**
 * The OAuth `state` for board sign-in: a nonce, its expiry and a server signature. The nonce is
 * also set as a cookie at login, and the callback must get it back: that binds the state to the
 * browser that started sign-in, which is what stops login CSRF (an attacker's own callback URL
 * signing a victim in as the attacker). The one exception is a plain-http localhost dev server,
 * where Chrome drops the cookie on the cross-site return from Cognito; there the signature and
 * expiry are checked alone.
 */
export const issueSignInState = (
  links: SignedLinks,
  returnTo?: string,
): { state: string; nonce: string } => {
  const nonce = randomBytes(16).toString('base64url');
  const path = safeReturnPath(returnTo);
  const { expires, signature } = links.sign(purpose(nonce, path), TTL_SECONDS);
  const base = `${nonce}.${String(expires)}.${signature}`;
  // The return path travels inside the state, under the signature; `/` is the default and is omitted.
  return {
    state: path === '/' ? base : `${base}.${Buffer.from(path).toString('base64url')}`,
    nonce,
  };
};

export type SignInStateCheck =
  | { readonly ok: true; readonly returnTo: string }
  | {
      readonly ok: false;
      readonly reason: 'malformed' | 'invalid or expired' | 'cookie missing' | 'cookie differs';
    };

/** `cookie` is the nonce cookie set at login, if the browser sent it back; `cookieRequired` is false only on localhost dev servers. */
export const checkSignInState = (
  links: SignedLinks,
  state: string | undefined,
  cookie: string | undefined,
  cookieRequired: boolean,
): SignInStateCheck => {
  const parts = (state ?? '').split('.');
  const [nonce, expires, signature, encoded] = parts;
  if (
    (parts.length !== 3 && parts.length !== 4) ||
    nonce === undefined ||
    expires === undefined ||
    signature === undefined ||
    nonce === ''
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const claimed = encoded === undefined ? '/' : Buffer.from(encoded, 'base64url').toString();
  if (!links.verify(purpose(nonce, claimed), Number(expires), signature))
    return { ok: false, reason: 'invalid or expired' };
  // Signed, but still re-validated: the redirect never trusts more than the rules above.
  const returnTo = safeReturnPath(claimed);
  if (cookie === undefined)
    return cookieRequired ? { ok: false, reason: 'cookie missing' } : { ok: true, returnTo };
  if (cookie !== nonce) return { ok: false, reason: 'cookie differs' };
  return { ok: true, returnTo };
};
