import { invalidInput, ok } from '@slop/core';
import type { Result } from '@slop/core';

/** The SSO session behind AWS_PROFILE: what the device flow needs and where the CLI keeps its token. */
export interface SsoProfile {
  /** The `[sso-session X]` name; the CLI's token cache file is named from it. */
  readonly session: string;
  readonly startUrl: string;
  readonly region: string;
  readonly scopes: readonly string[];
}

type Sections = Map<string, Map<string, string>>;

/** A minimal ini reader for ~/.aws/config: `[section]` headers and `key = value` lines, `#`/`;` comments. */
const parseIni = (text: string): Sections => {
  const sections: Sections = new Map();
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      current = sections.get(header[1].trim()) ?? new Map();
      sections.set(header[1].trim(), current);
      continue;
    }
    const eq = line.indexOf('=');
    if (current !== null && eq > 0)
      current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return sections;
};

/** Session names become part of a file name only through a hash, but keep them to plain names anyway. */
const SESSION_NAME = /^[\w.-]+$/;

/**
 * The SSO session of AWS_PROFILE, from the AWS config's text. Fails (with why) when no profile is set
 * or it doesn't use an `sso_session` with a start URL and region: the legacy inline sso_* profile
 * format caches its token differently and isn't supported.
 */
export const readSsoProfile = (
  env: { readonly AWS_PROFILE?: string | undefined },
  configText: string,
): Result<SsoProfile> => {
  const profile = env.AWS_PROFILE;
  if (profile === undefined || profile === '') return invalidInput('AWS_PROFILE is not set');
  const sections = parseIni(configText);
  const own = sections.get(profile === 'default' ? 'default' : `profile ${profile}`);
  const session = own?.get('sso_session');
  if (session === undefined || !SESSION_NAME.test(session))
    return invalidInput('The AWS profile has no sso_session');
  const shared = sections.get(`sso-session ${session}`);
  const startUrl = shared?.get('sso_start_url');
  const region = shared?.get('sso_region');
  if (startUrl === undefined || region === undefined || !/^https:\/\//.test(startUrl)) {
    return invalidInput('The SSO session has no valid sso_start_url and sso_region');
  }
  const listed = (shared?.get('sso_registration_scopes') ?? '')
    .split(/[\s,]+/)
    .filter((s) => s !== '');
  // Without a scope the token can't call GetRoleCredentials; this is AWS's own default.
  const scopes = listed.length === 0 ? ['sso:account:access'] : listed;
  return ok({ session, startUrl, region, scopes });
};

/** Only a server on this machine may offer the sign-in: it signs in the server's own AWS profile. */
export const isLocalUrl = (publicUrl: string): boolean => {
  try {
    const host = new URL(publicUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
};
