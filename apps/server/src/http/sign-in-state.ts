import { randomBytes } from 'node:crypto';
import type { SignedLinks } from '../signed-links.js';

const TTL_SECONDS = 600;
const purpose = (nonce: string): string => `board-sign-in:${nonce}`;

/**
 * The OAuth `state` for board sign-in: a nonce, its expiry and a server signature. The nonce is
 * also set as a cookie at login, and the callback must get it back: that binds the state to the
 * browser that started sign-in, which is what stops login CSRF (an attacker's own callback URL
 * signing a victim in as the attacker). The one exception is a plain-http localhost dev server,
 * where Chrome drops the cookie on the cross-site return from Cognito; there the signature and
 * expiry are checked alone.
 */
export const issueSignInState = (links: SignedLinks): { state: string; nonce: string } => {
  const nonce = randomBytes(16).toString('base64url');
  const { expires, signature } = links.sign(purpose(nonce), TTL_SECONDS);
  return { state: `${nonce}.${String(expires)}.${signature}`, nonce };
};

export type SignInStateCheck =
  | { readonly ok: true }
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
  const [nonce, expires, signature] = parts;
  if (
    parts.length !== 3 ||
    nonce === undefined ||
    expires === undefined ||
    signature === undefined ||
    nonce === ''
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (!links.verify(purpose(nonce), Number(expires), signature))
    return { ok: false, reason: 'invalid or expired' };
  if (cookie === undefined)
    return cookieRequired ? { ok: false, reason: 'cookie missing' } : { ok: true };
  if (cookie !== nonce) return { ok: false, reason: 'cookie differs' };
  return { ok: true };
};
