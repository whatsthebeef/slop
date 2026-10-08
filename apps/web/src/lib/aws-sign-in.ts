import type { IntegrationHealthView } from '@/lib/api';

type SignIn = NonNullable<IntegrationHealthView['awsSignIn']>;

/** What the bar's Sign in to AWS action shows for the server's sign-in state. */
export type SignInView =
  | { readonly kind: 'button' }
  | { readonly kind: 'ask-admin' }
  | { readonly kind: 'waiting'; readonly verificationUri: string; readonly userCode: string }
  | { readonly kind: 'failed'; readonly message: string; readonly canRetry: boolean };

/** Null when this server has no sign-in. A person who can't start it is told to ask an admin; a failure offers another try. */
export const signInView = (sign: SignIn | null): SignInView | null => {
  if (sign === null) return null;
  if (sign.state === 'waiting')
    return { kind: 'waiting', verificationUri: sign.verificationUri, userCode: sign.userCode };
  if (sign.state === 'failed')
    return { kind: 'failed', message: sign.message, canRetry: sign.canStart };
  return sign.canStart ? { kind: 'button' } : { kind: 'ask-admin' };
};

/** Poll the sign-in's progress quickly while it waits for the person to approve. */
export const signInPoll = (sign: SignIn | null | undefined): number =>
  sign?.state === 'waiting' ? 3_000 : 30_000;
