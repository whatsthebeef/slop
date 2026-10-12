import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { LlmBusy, LlmUnavailable } from '@slop/core';
import type { LlmSpendTag } from '@slop/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BEDROCK_CLIENT_RETRY, BedrockLlm, shownModelId, spendRecorder } from '../src/llm.js';
import type { LlmUsage } from '../src/llm.js';

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
    ['ValidationException', 'Invocation of model ID anthropic.x with on-demand throughput isn’t supported. Retry with an inference profile.', `The Bedrock model ${MODEL} isn't valid here`],
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
    ['ServiceUnavailableException', 'Bedrock is unable to process your request.'],
    ['ModelNotReadyException', 'The model is not ready'],
    ['ServiceQuotaExceededException', 'Quota exceeded'],
    ['InternalServerException', 'Internal failure'],
    ['ModelTimeoutException', 'Model timed out'],
    ['TimeoutError', 'Request timed out'],
  ])('classifies %s as busy: wait and retry, no attempt spent', async (name, message) => {
    expect(await failWith(sdkError(name, message))).toBeInstanceOf(LlmBusy);
  });

  it.each([
    ['ValidationException', 'temperature is not supported'],
    ['ValidationException', `model ID ${MODEL}: extended output for this request is not supported`],
    ['AbortError', 'The operation was aborted'],
  ])('rethrows %s unchanged', async (name, message) => {
    const error = sdkError(name, message);
    expect(await failWith(error)).toBe(error);
  });

  it('retries adaptively, up to five attempts', () => {
    expect(BEDROCK_CLIENT_RETRY).toEqual({ retryMode: 'adaptive', maxAttempts: 5 });
  });
});

/**
 * Makes `send` resolve with `output`. Its last overload (callback style) returns void, so the typed mock helpers expect
 * void; BedrockLlm only uses the promise overload.
 */
const respondWith = (output: object) =>
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the promise overload of send, see above
  vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(() => Promise.resolve(output));

describe('BedrockLlm usage and the spend tag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const TAG: LlmSpendTag = { boardId: 7, source: 'chat', globId: 's7t1' };

  /** Records each usage report with its tag. */
  const listener = () => {
    const heard: { usage: LlmUsage; spend: LlmSpendTag | undefined }[] = [];
    return { heard, onUsage: (usage: LlmUsage, spend?: LlmSpendTag) => void heard.push({ usage, spend }) };
  };

  it('hands the tag to the usage listener, and never puts it in the Converse command (the prompt is unchanged)', async () => {
    const send = respondWith({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    const { heard, onUsage } = listener();
    const llm = new BedrockLlm({ id: MODEL, configKey: 'CHAT_MODEL' }, 'us-east-1', onUsage, null);
    expect(await llm.complete({ system: 's', prompt: 'p', maxTokens: 10, spend: TAG })).toBe('ok');
    expect(heard).toEqual([{ usage: { model: MODEL, input: 12, output: 3 }, spend: TAG }]);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(ConverseCommand);
    expect(command?.input).toEqual({
      modelId: MODEL,
      system: [{ text: 's' }],
      messages: [{ role: 'user', content: [{ text: 'p' }] }],
      inferenceConfig: { maxTokens: 10 },
    });
    expect(JSON.stringify(command?.input)).not.toContain('spend');
    expect(JSON.stringify(command?.input)).not.toContain('s7t1');
  });

  it('hands the tag over from a stream too, with no spend in the ConverseStream command', async () => {
    // `for await` reads a plain array like the SDK's event stream.
    const events = [
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hel' } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'lo' } } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, metrics: { latencyMs: 1 } } },
    ];
    const send = respondWith({ stream: events });
    const { heard, onUsage } = listener();
    const llm = new BedrockLlm({ id: MODEL, configKey: 'CHAT_MODEL' }, 'us-east-1', onUsage, null);
    const pieces: string[] = [];
    expect(await llm.stream({ system: 's', prompt: 'p', maxTokens: 10, spend: TAG }, (t) => pieces.push(t))).toBe('Hello');
    expect(pieces).toEqual(['Hel', 'lo']);
    expect(heard).toEqual([{ usage: { model: MODEL, input: 5, output: 2 }, spend: TAG }]);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(ConverseStreamCommand);
    expect(command?.input).not.toHaveProperty('spend');
    expect(JSON.stringify(command?.input)).not.toContain('s7t1');
  });

  it('reports an untagged call without a tag, and a failing listener never fails the call', async () => {
    respondWith({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { heard, onUsage } = listener();
    expect(await new BedrockLlm({ id: MODEL, configKey: 'CHAT_MODEL' }, 'us-east-1', onUsage).complete({ system: 's', prompt: 'p', maxTokens: 10 })).toBe('ok');
    expect(heard).toEqual([{ usage: { model: MODEL, input: 1, output: 1 }, spend: undefined }]);
    const throwing = new BedrockLlm({ id: MODEL, configKey: 'CHAT_MODEL' }, 'us-east-1', () => {
      throw new Error('listener broke');
    });
    expect(await throwing.complete({ system: 's', prompt: 'p', maxTokens: 10, spend: TAG })).toBe('ok');
    const rejecting = new BedrockLlm({ id: MODEL, configKey: 'CHAT_MODEL' }, 'us-east-1', () => Promise.reject(new Error('ledger down')));
    expect(await rejecting.complete({ system: 's', prompt: 'p', maxTokens: 10, spend: TAG })).toBe('ok');
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
  });
});

describe('spendRecorder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const USAGE: LlmUsage = { model: MODEL, input: 1_000, output: 200 };

  it('writes one ledger row for a tagged call, with its board, source and glob', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const record = vi.fn(() => Promise.resolve());
    const log = vi.fn();
    await spendRecorder({ record }, log)(USAGE, { boardId: 3, source: 'intake' });
    await spendRecorder({ record }, log)(USAGE, { boardId: 3, source: 'kb_draft', globId: 's3k1' });
    expect(record.mock.calls).toEqual([
      [{ boardId: 3, globId: null, source: 'intake', model: MODEL, inputTokens: 1_000, outputTokens: 200, ref: null }],
      [{ boardId: 3, globId: 's3k1', source: 'kb_draft', model: MODEL, inputTokens: 1_000, outputTokens: 200, ref: null }],
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it('only logs an untagged call (reviews, the knowledge page and the sign-in probe write no row here)', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const record = vi.fn(() => Promise.resolve());
    await spendRecorder({ record }, vi.fn())(USAGE);
    expect(record).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(`[llm] ${MODEL} in=1000 out=200`);
  });

  it('logs a ledger error instead of throwing it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const record = vi.fn(() => Promise.reject(new Error('connection refused')));
    const log = vi.fn();
    await expect(spendRecorder({ record }, log)(USAGE, { boardId: 3, source: 'chat' })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('Could not record chat spend for board 3: connection refused');
  });
});
