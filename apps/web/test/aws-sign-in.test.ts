import { describe, expect, it } from 'vitest';
import { signInPoll, signInView } from '../src/lib/aws-sign-in';

describe("the bar's AWS sign-in action", () => {
  it('shows nothing where the server has no sign-in', () => {
    expect(signInView(null)).toBeNull();
  });

  it('offers the button to an admin, and tells anyone else to ask one', () => {
    expect(signInView({ canStart: true, state: 'idle' })).toEqual({ kind: 'button' });
    expect(signInView({ canStart: false, state: 'idle' })).toEqual({ kind: 'ask-admin' });
  });

  it('shows the link and code while waiting, whoever is looking', () => {
    const waiting = {
      state: 'waiting',
      verificationUri: 'https://v?c=1',
      userCode: 'CODE-1234',
      expiresAt: 'x',
    } as const;
    const expected = { kind: 'waiting', verificationUri: 'https://v?c=1', userCode: 'CODE-1234' };
    expect(signInView({ canStart: true, ...waiting })).toEqual(expected);
    expect(signInView({ canStart: false, ...waiting })).toEqual(expected);
  });

  it('says why it failed and lets an admin try again', () => {
    expect(signInView({ canStart: true, state: 'failed', message: 'Sign-in expired' })).toEqual({
      kind: 'failed',
      message: 'Sign-in expired',
      canRetry: true,
    });
    expect(
      signInView({ canStart: false, state: 'failed', message: 'Sign-in expired' }),
    ).toMatchObject({ canRetry: false });
  });

  it('shows the button again after a finished sign-in, and polls fast only while waiting', () => {
    expect(signInView({ canStart: true, state: 'done' })).toEqual({ kind: 'button' });
    expect(
      signInPoll({
        canStart: true,
        state: 'waiting',
        verificationUri: 'u',
        userCode: 'c',
        expiresAt: 'x',
      }),
    ).toBeLessThan(signInPoll(null));
  });
});
