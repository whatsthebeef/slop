import { describe, expect, it } from 'vitest';
import { FAILURE_NOTE_MAX, maskedNote, maskSecrets } from '../src/domain/mask-secrets.js';

describe('maskSecrets', () => {
  it('masks AWS access key IDs', () => {
    expect(maskSecrets('key AKIAABCDEFGHIJKLMNOP and ASIAABCDEFGHIJKLMNOP.')).toBe('key [masked] and [masked].');
  });

  it('masks secret keys and session tokens after their names, keeping the name', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    expect(maskSecrets(`aws_secret_access_key = ${secret}`)).toBe('aws_secret_access_key = [masked]');
    expect(maskSecrets(`export AWS_SECRET_ACCESS_KEY=${secret}`)).toBe('export AWS_SECRET_ACCESS_KEY=[masked]');
    expect(maskSecrets(`"SecretAccessKey": "${secret}",`)).toBe('"SecretAccessKey": "[masked]",');
    expect(maskSecrets(`AWS_SESSION_TOKEN=IQoJb3JpZ2luX2VjEXAMPLE+token/value==`)).toBe('AWS_SESSION_TOKEN=[masked]');
    expect(maskSecrets(`"SessionToken": "FwoGZXIvYXdzEXAMPLEEXAMPLEEXAMPLE"`)).toBe('"SessionToken": "[masked]"');
  });

  it('masks bearer and authorization values, keeping the scheme', () => {
    expect(maskSecrets('curl -H "Authorization: Bearer abcdef1234567890.xyz" https://x.test')).toBe('curl -H "Authorization: Bearer [masked]" https://x.test');
    expect(maskSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic [masked]');
    expect(maskSecrets('sent Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig today')).toBe('sent Bearer [masked] today');
  });

  it('masks GitHub tokens', () => {
    expect(maskSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789 done')).toBe('[masked] done');
    expect(maskSecrets('github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz0123456789')).toBe('[masked]');
    expect(maskSecrets('gho_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('[masked]');
  });

  it('masks password, token and secret assignments, keeping the name', () => {
    expect(maskSecrets('password=hunter2')).toBe('password=[masked]');
    expect(maskSecrets('DB_PASSWORD: "s3cret!"')).toBe('DB_PASSWORD: "[masked]"');
    expect(maskSecrets('curl "https://x.test/a?token=abc123&b=2"')).toBe('curl "https://x.test/a?token=[masked]&b=2"');
    expect(maskSecrets('client_secret=abc --api-key=zzz')).toBe('client_secret=[masked] --api-key=[masked]');
  });

  it('masks PEM blocks, also one that is cut off', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----';
    expect(maskSecrets(`before\n${pem}\nafter`)).toBe('before\n[masked]\nafter');
    expect(maskSecrets('x\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nabc')).toBe('x\n[masked]');
  });

  it('masks credentials inside URLs', () => {
    expect(maskSecrets('git clone https://user:p4ss@github.com/a/b.git')).toBe('git clone https://[masked]@github.com/a/b.git');
    expect(maskSecrets('https://ghs_tokenvalue@github.com/a/b')).toBe('https://[masked]@github.com/a/b');
    expect(maskSecrets('postgres://slop:pw@db:5432/slop')).toBe('postgres://[masked]@db:5432/slop');
  });

  it('leaves harmless text alone', () => {
    const text = 'Stack update failed: AccessDenied for iam:CreatePolicy on arn:aws:iam::123456789012:policy/x (https://example.com/docs).\nUse the token you were given; mailto me@example.com';
    expect(maskSecrets(text)).toBe(text);
    expect(maskSecrets('')).toBe('');
  });

  it('is idempotent', () => {
    const once = maskSecrets('Authorization: Bearer abcdefgh12345 password=x https://u:p@h/');
    expect(maskSecrets(once)).toBe(once);
  });
});

describe('maskSecrets cost', () => {
  const inputs: Record<string, string> = {
    dotted: 'a.'.repeat(50_000),
    hyphenated: 'a-'.repeat(50_000),
    keywords: 'token'.repeat(20_000),
    passwords: 'password.'.repeat(11_000),
    schemes: 'a+'.repeat(50_000) + '://',
    urls: 'x://a'.repeat(20_000),
  };
  for (const [name, input] of Object.entries(inputs)) {
    it(`stays linear on 100k characters of ${name}`, () => {
      const started = performance.now();
      maskSecrets(input);
      expect(performance.now() - started).toBeLessThan(500);
    });
  }

  it('masks Slack tokens and bare JWTs', () => {
    expect(maskSecrets('slack xoxb-123456789012-abcdefABCDEF done')).toBe('slack [masked] done');
    expect(maskSecrets('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF_-123 end')).toBe('jwt [masked] end');
  });

  it('still masks URL credentials and prefixed names', () => {
    expect(maskSecrets('git clone https://user:pw@host.test/x')).toBe('git clone https://[masked]@host.test/x');
    expect(maskSecrets('my.service-token_value=abc')).toBe('my.service-token_value=[masked]');
  });
});

describe('maskedNote', () => {
  it('masks, trims and keeps short notes whole', () => {
    expect(maskedNote('  failed with password=abc  \n')).toBe('failed with password=[masked]');
  });

  it('caps a long note after masking', () => {
    const note = maskedNote('y'.repeat(FAILURE_NOTE_MAX + 500));
    expect(note.startsWith('y'.repeat(FAILURE_NOTE_MAX))).toBe(true);
    expect(note).toContain(`[note cut at ${FAILURE_NOTE_MAX} characters]`);
    expect(note.length).toBeLessThan(FAILURE_NOTE_MAX + 60);
  });

  it('masks a secret that straddles the cap', () => {
    const note = maskedNote(`${'a '.repeat(FAILURE_NOTE_MAX / 2 - 6)}ghp_abcdefghijklmnopqrstuvwxyz0123456789 tail`);
    expect(note).not.toContain('ghp_');
  });
});
