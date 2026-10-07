import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { LlmUnavailable } from '@slop/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BedrockLlm, shownModelId } from '../src/llm.js';

const MODEL = 'us.anthropic.claude-opus-5-5';

/** An SDK-style error: the SDK tells failures apart by `name`. */
const sdkError = (name: string, message: string): Error => Object.assign(new Error(message), { name });

const failWith = async (error: Error, profile?: string, modelId: string = MODEL): Promise<unknown> => {
  vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockRejectedValue(error);
  if (profile === undefined) vi.stubEnv('AWS_PROFILE', undefined);
  else vi.stubEnv('AWS_PROFILE', profile);
  const llm = new BedrockLlm({ id: modelId, configKey: 'KB_ROUTE_MODEL' }, 'us-east-1');
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
    ['ResourceNotFoundException', 'Model use case details have not been submitted for this account. RequestId: abc-123', `The Bedrock model ${MODEL} isn't found or enabled`],
    ['ValidationException', 'The provided model identifier is invalid.', `The Bedrock model ${MODEL} isn't valid here`],
    ['ValidationException', "Invocation of model ID anthropic.x with on-demand throughput isn't supported.", `The Bedrock model ${MODEL} isn't valid here`],
  ])('classifies %s as unavailable', async (name, message, reason) => {
    const thrown = await failWith(sdkError(name, message));
    expect(thrown).toBeInstanceOf(LlmUnavailable);
    if (!(thrown instanceof LlmUnavailable)) return;
    expect(thrown.reason).toBe(reason);
    // The fix is slop's own words: no account IDs, ARNs or request IDs from the SDK's message.
    expect(thrown.fix).not.toMatch(/123456789012|abc-123|arn:/);
    expect(thrown.message).not.toMatch(/123456789012|abc-123|arn:/);
  });

  it('names the model setting and the Bedrock console in the fix for a model that is not found or not valid', async () => {
    const thrown = await failWith(sdkError('ResourceNotFoundException', 'Model use case details have not been submitted'));
    if (!(thrown instanceof LlmUnavailable)) throw new Error('expected LlmUnavailable');
    expect(thrown.fix).toBe('Check KB_ROUTE_MODEL and that model access is enabled in the Bedrock console (us-east-1)');
  });

  it("makes the credential chain's catch-all fix depend on the setup: sign-in with a profile, the IAM role without", async () => {
    const odd = () => sdkError('CredentialsProviderError', 'Failed to connect to the instance metadata service');
    const withProfile = await failWith(odd(), 'slop-dev');
    if (!(withProfile instanceof LlmUnavailable)) throw new Error('expected LlmUnavailable');
    expect(withProfile.reason).toBe('AWS sign-in expired');
    expect(withProfile.fix).toContain('aws sso login --profile slop-dev');
    const withoutProfile = await failWith(odd());
    if (!(withoutProfile instanceof LlmUnavailable)) throw new Error('expected LlmUnavailable');
    expect(withoutProfile.reason).toBe("The server's AWS credentials couldn't be loaded");
    expect(withoutProfile.fix).toContain('IAM role');
    expect(withoutProfile.fix).not.toContain('sso');
  });

  it('masks the account ID of a model given as an ARN', async () => {
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc';
    expect(shownModelId(arn)).toBe('arn:aws:bedrock:us-east-1:<account>:application-inference-profile/abc');
    const thrown = await failWith(sdkError('AccessDeniedException', 'denied'), undefined, arn);
    if (!(thrown instanceof LlmUnavailable)) throw new Error('expected LlmUnavailable');
    expect(thrown.message).not.toContain('123456789012');
    expect(thrown.reason).toContain('<account>');
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
