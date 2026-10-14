import { describe, expect, it } from 'vitest';
import { atfSettingSchema } from '../src/http/app.js';

const ok = { provider: 'codebuild', region: 'eu-west-2', project: 'atf-staging', mode: 'push' } as const;

describe('the board ATF setting', () => {
  it('accepts a well-formed setting, with or without a role', () => {
    expect(atfSettingSchema.safeParse(ok).success).toBe(true);
    expect(atfSettingSchema.safeParse({ ...ok, roleArn: 'arn:aws:iam::123456789012:role/ci/atf-starter' }).success).toBe(true);
  });

  it.each([
    ['region', 'eu-west-2.evil.example/x'],
    ['region', 'EU-WEST-2'],
    ['project', 'a b'],
    ['project', ''],
    ['roleArn', 'arn:aws:iam::123:role/x'],
    ['roleArn', 'arn:aws:iam::123456789012:user/x'],
    ['roleArn', 'arn:aws:sts::123456789012:assumed-role/x/y'],
  ])('refuses a malformed %s (%s)', (field, value) => {
    expect(atfSettingSchema.safeParse({ ...ok, [field]: value }).success).toBe(false);
  });
});
