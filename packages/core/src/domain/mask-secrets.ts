/**
 * Best-effort masking of credentials in text a person pastes (a failed rollout step's output, s15t228). It is not a
 * guarantee: people are warned to strip keys, tokens and passwords first, and this catches the common shapes
 * (AWS keys and tokens, bearer and basic authorization, GitHub tokens, `password=` style assignments, PEM blocks and
 * credentials inside URLs). Pure, so the service and any surface can use it.
 */

export const MASKED = '[masked]';

/** The most a stored failure note keeps, after masking. */
export const FAILURE_NOTE_MAX = 8000;

/** Input beyond this is dropped before masking, so a huge paste can't make the patterns slow. */
const INPUT_MAX = 100_000;

/** Each rule turns what it matches into itself with the secret part replaced; `$1` is the part that stays. */
const RULES: readonly (readonly [RegExp, string])[] = [
  // PEM blocks, including one cut off before its END line.
  [/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?(?:-----END \1-----|$)/g, MASKED],
  // AWS access key IDs (long-term and temporary).
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, MASKED],
  // AWS secret keys and session tokens by their name, as env, ini, JSON or flags.
  [/((?:aws_secret_access_key|secret_?access_?key|aws_session_token|session_?token)["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=%_-]{16,}/gi, `$1${MASKED}`],
  // GitHub tokens.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, MASKED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, MASKED],
  // Authorization header values (the scheme stays), then any other bearer token.
  [/(authorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?)(?!\[masked\]|(?:bearer|basic|token)\s)[^\s"',;]+/gi, `$1${MASKED}`],
  [/(\bbearer\s+)(?!\[masked\])[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASKED}`],
  // Slack tokens and bare JWTs (three base64url parts).
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, MASKED],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, MASKED],
  // Credentials inside a URL: scheme://user:pass@host or scheme://token@host.
  // The scheme is bounded so a long dotted run can't restart a scan at every word boundary (linear on any input).
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/gi, `$1${MASKED}@`],
  // password=..., token: ..., client_secret=..., api_key=... (the name stays, so no prefix is matched; the suffix is
  // bounded, so repeated keywords can't make the scan quadratic).
  [/((?:password|passwd|pwd|token|secret|api[_-]?key)[\w.-]{0,40}["']?\s*[:=]\s*["']?)(?!\[masked\])[^\s"'&;,]+/gi, `$1${MASKED}`],
];

/** The text with credentials replaced by `[masked]`. */
export const maskSecrets = (text: string): string => RULES.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), text);

/** A pasted failure note as it is stored: masked first (so a secret cut by the cap can't survive), then capped. */
export const maskedNote = (text: string): string => {
  const masked = maskSecrets(text.slice(0, INPUT_MAX)).trim();
  return masked.length > FAILURE_NOTE_MAX ? `${masked.slice(0, FAILURE_NOTE_MAX)}\n[note cut at ${FAILURE_NOTE_MAX} characters]` : masked;
};
