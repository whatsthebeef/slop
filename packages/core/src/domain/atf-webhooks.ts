import { invalidInput, ok } from './errors.js';
import type { Result } from './errors.js';

/**
 * The deploy-live webhook (spec, ATF runners): slop tells a runner that a deploy is live and checked, so the runner can start
 * itself. Everything here is pure: the address rules, the payload and what is signed. DNS, TLS and the HMAC are the server's.
 */

export const MAX_WEBHOOK_URL = 500;

export const WEBHOOK_EVENT = 'deploy.live';

/** Header names of a delivery; the receiver verifies `Slop-Signature` over `<Slop-Timestamp>.<body>` with its signing secret. */
export const WEBHOOK_HEADERS = {
  event: 'Slop-Event',
  delivery: 'Slop-Delivery',
  timestamp: 'Slop-Timestamp',
  signature: 'Slop-Signature',
} as const;

/** What is signed: the timestamp the receiver can check for replays, a dot, then the exact body bytes. */
export const webhookSignedText = (timestamp: number, body: string): string =>
  `${String(timestamp)}.${body}`;

/** The signature header's value for a digest in hex. */
export const webhookSignatureHeader = (hexDigest: string): string => `sha256=${hexDigest}`;

/** One delivery per runner and deploy; the same ID on every retry, so a receiver can ignore one it already handled. */
export const webhookDeliveryId = (runnerId: number, deployId: string): string =>
  `atf-${String(runnerId)}-${deployId}`;

export interface DeployLiveEvent {
  readonly boardId: number;
  readonly boardName: string;
  readonly environment: string;
  readonly sha: string;
  readonly deployId: string;
  /** When the deploy happened. */
  readonly deployedAt: string;
  readonly deliveryId: string;
}

/** The JSON body of a deploy-live delivery. */
export const deployLiveBody = (event: DeployLiveEvent): string =>
  JSON.stringify({
    event: WEBHOOK_EVENT,
    id: event.deliveryId,
    board: { id: event.boardId, name: event.boardName },
    environment: event.environment,
    sha: event.sha,
    deployId: event.deployId,
    deployedAt: event.deployedAt,
  });

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const parseIpv4 = (text: string): number[] | null => {
  const m = IPV4.exec(text);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
};

/** `[address, prefix length]` of IPv4 ranges a webhook must never reach (private, loopback, link-local, reserved). */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const v4Number = (p: readonly number[]): number =>
  (p[0] ?? 0) * 2 ** 24 + (p[1] ?? 0) * 2 ** 16 + (p[2] ?? 0) * 2 ** 8 + (p[3] ?? 0);

const blockedV4 = (parts: readonly number[]): boolean => {
  const n = v4Number(parts);
  return BLOCKED_V4.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4Number(parseIpv4(base) ?? [0, 0, 0, 0]);
    return n >= start && n < start + size;
  });
};

/** Eight 16-bit groups of an IPv6 address, or null when the text isn't one. */
const parseIpv6 = (input: string): number[] | null => {
  let text = input.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (!text.includes(':')) return null;
  // A dotted IPv4 tail stands for the last two groups.
  const tail = text.slice(text.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, text.lastIndexOf(':') + 1)}${((v4[0] ?? 0) * 256 + (v4[1] ?? 0)).toString(16)}:${((v4[2] ?? 0) * 256 + (v4[3] ?? 0)).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const group = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = group(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = group(halves[1] ?? '');
  if (rest === null || head.length + rest.length > 7) return null;
  return [...head, ...Array<number>(8 - head.length - rest.length).fill(0), ...rest];
};

const embeddedV4 = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255];

/**
 * Why a webhook must not connect to this IP address, or null when it is a public one. Refuses private, loopback,
 * link-local, multicast, documentation and other reserved ranges, and for IPv6 anything outside global unicast
 * (an IPv4-mapped, NAT64 or 6to4 address is judged by the IPv4 address inside it).
 */
export const addressRefusal = (ip: string): string | null => {
  const refused = 'The address is private or reserved';
  const v4 = parseIpv4(ip);
  if (v4 !== null) return blockedV4(v4) ? refused : null;
  const g = parseIpv6(ip);
  if (g === null) return 'Not an IP address';
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64) stand for the IPv4 address inside.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff)
    return blockedV4(embeddedV4(g6, g7)) ? refused : null;
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return blockedV4(embeddedV4(g6, g7)) ? refused : null;
  if (g0 === 0x2002) return blockedV4(embeddedV4(g1, g2)) ? refused : null;
  // Global unicast only (2000::/3), minus the protocol-assignment and documentation blocks inside it.
  if (g0 < 0x2000 || g0 > 0x3fff) return refused;
  if (g0 === 0x2001 && (g1 < 0x200 || g1 === 0xdb8)) return refused;
  if (g0 === 0x3fff && g1 < 0x1000) return refused;
  return null;
};

const LOCAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.lan',
  '.home.arpa',
  '.intranet',
  '.corp',
];

/**
 * Checks a webhook URL before it is saved: https, no credentials in it, a public-looking host (a literal IP address in a
 * blocked range, `localhost`, a single-label or internal-looking name is refused). A name's addresses are the server's to
 * check, now and at every delivery.
 */
export const validateWebhookUrl = (raw: string): Result<{ readonly hostname: string }> => {
  if (raw.length > MAX_WEBHOOK_URL)
    return invalidInput(`The webhook URL is at most ${String(MAX_WEBHOOK_URL)} characters`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalidInput('The webhook URL must be an https URL');
  }
  if (url.protocol !== 'https:') return invalidInput('The webhook URL must be an https URL');
  if (url.username !== '' || url.password !== '')
    return invalidInput('The webhook URL must not contain a user name or password');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === '') return invalidInput('The webhook URL needs a host');
  const literal = hostname.startsWith('[') || parseIpv4(hostname) !== null;
  if (literal) {
    return addressRefusal(hostname) === null
      ? ok({ hostname })
      : invalidInput('The webhook URL must not point at a private or reserved address');
  }
  if (
    !hostname.includes('.') ||
    hostname === 'localhost' ||
    LOCAL_SUFFIXES.some((s) => hostname.endsWith(s))
  ) {
    return invalidInput('The webhook URL must name a public host');
  }
  return ok({ hostname });
};
