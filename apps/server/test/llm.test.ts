import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { LlmUnavailable } from '@slop/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BedrockLlm } from '../src/llm.js';

const MODEL = 'us.anthropic.claude-opus-5-5';

/** An SDK-style error: the SDK tells failures apart by `name`. */
const sdkError = (name: string, message: string): Error => Object.assign(new Error(message), { name });

const failWith = async (error: Error, profile?: string): Promise<unknown> => {
  vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockRejectedValue(error);
  if (profile === undefined) vi.stubEnv('AWS_PROFILE', undefined);
  else vi.stubEnv('AWS_PROFILE', profile);
  const llm = new BedrockLlm(MODEL, 'us-east-1');
  return llm.complete({ system: 's', prompt: 'p', maxTokens: 10 }).then(
    () => {
      throw new Error('expected the call to fail');
    },
    (thrown: unknown) => thrown,
  );
};

describe('BedrockLlm error classification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('turns an expired SSO token into "AWS sign-in expired" with the profile in the fix', async () => {
    const thrown = await failWith(
      sdkError('TokenProviderError', "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile."),
      'slop-dev',
    );
    expect(thrown).toBeInstanceOf(LlmUnavailable);
    if (!(thrown instanceof LlmUnavailable)) return;
    expect(thrown.reason).toBe('AWS sign-in expired');
    expect(thrown.fix).toContain('aws sso login --profile slop-dev');
    expect(thrown.fix).toContain('IAM Identity Center');
  });

  it.each([
    ['CredentialsProviderError', 'The SSO session associated with this profile has expired. To refresh this SSO session run aws sso login with the corresponding profile.', 'AWS sign-in expired'],
    ['ExpiredTokenException', 'The security token included in the request is expired', 'AWS sign-in expired'],
    ['UnrecognizedClientException', 'The security token included in the request is invalid. RequestId: abc-123', 'AWS credentials are not valid'],
    ['CredentialsProviderError', 'Could not load credentials from any providers', 'No AWS credentials'],
    ['AccessDeniedException', 'User: arn:aws:sts::123456789012:assumed-role/x is not authorized. RequestId: abc-123', `No access to the Bedrock model ${MODEL}`],
  ])('classifies %s as unavailable', async (name, message, reason) => {
    const thrown = await failWith(sdkError(name, message));
    expect(thrown).toBeInstanceOf(LlmUnavailable);
    if (!(thrown instanceof LlmUnavailable)) return;
    expect(thrown.reason).toBe(reason);
    // The fix is slop's own words: no account IDs, ARNs or request IDs from the SDK's message.
    expect(thrown.fix).not.toMatch(/123456789012|abc-123|arn:/);
    expect(thrown.message).not.toMatch(/123456789012|abc-123|arn:/);
  });

  it.each([
    ['ThrottlingException', 'Too many requests'],
    ['ModelTimeoutException', 'Model timed out'],
    ['ValidationException', 'temperature is not supported'],
    ['AbortError', 'The operation was aborted'],
  ])('rethrows %s unchanged', async (name, message) => {
    const error = sdkError(name, message);
    expect(await failWith(error)).toBe(error);
  });
});
