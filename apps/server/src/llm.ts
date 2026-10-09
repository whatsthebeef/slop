import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { LlmBusy, LlmUnavailable } from '@slop/core';
import type { Llm, LlmRequest } from '@slop/core';

/** A Bedrock model and the setting that chose it (named in the fix when the model can't be used). */
export interface BedrockModel {
  readonly id: string;
  /** The environment variable that sets it, e.g. KB_ROUTE_MODEL. */
  readonly configKey: string;
}

/** Where the failing call ran, to make the fix concrete. */
interface CallSite {
  readonly model: BedrockModel;
  readonly region: string;
  readonly profile: string | undefined;
}

/**
 * A model ID as shown to people: an ARN's 12-digit account ID is masked, since reasons reach
 * `/api/health`, the Knowledge page's waiting cards and the intake error.
 */
export const shownModelId = (id: string): string => id.replace(/(?<!\d)\d{12}(?!\d)/g, '<account>');

const signInFix = (profile: string | undefined): string =>
  `Run \`aws sso login${profile === undefined ? '' : ` --profile ${profile}`}\` on the server, or ask an admin to lengthen the IAM Identity Center session`;

/**
 * A credential-chain failure that isn't plainly an expired sign-in or missing credentials. With a
 * profile it's almost always the SSO session; without one the server runs on an IAM role or
 * environment credentials, which `aws sso login` doesn't fix.
 */
const unloadedCredentials = (profile: string | undefined): LlmUnavailable =>
  profile === undefined
    ? new LlmUnavailable("The server's AWS credentials couldn't be loaded", "Check the server's IAM role (or its AWS environment credentials)")
    : new LlmUnavailable('AWS sign-in expired', signInFix(profile));

/** Bedrock's own wording for a model ID it can't use (it writes "isn’t" with a typographic apostrophe), and nothing broader. */
const MODEL_ID_INVALID =
  /the provided model identifier is invalid|invocation of model id \S+ with on-demand throughput (isn't|isn’t|is not) supported/i;

const modelFix = (site: CallSite): string =>
  `Check ${site.model.configKey} and that model access is enabled in the Bedrock console (${site.region})`;

/**
 * Transient Bedrock errors: throttling, overload ("Bedrock is unable to process your request" is the message of
 * `ServiceUnavailableException`), a model still loading, quota bursts, server errors and SDK timeouts. They pass,
 * so they become `LlmBusy` (wait and retry, no attempt spent), not a failure and not "unavailable".
 */
const BUSY_ERRORS: ReadonlySet<string> = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'ModelNotReadyException',
  'ServiceQuotaExceededException',
  'InternalServerException',
  'ModelTimeoutException',
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
]);

/** Adaptive retry spreads the SDK's own retries under throttling; the pipelines' waits take over after these. */
export const BEDROCK_CLIENT_RETRY = { retryMode: 'adaptive', maxAttempts: 5 } as const;

const nameOf = (error: unknown): string =>
  error instanceof Error ? error.name : '';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : '');

/**
 * Credential and access failures, which no retry fixes until a person acts, as `LlmUnavailable`
 * with a plain-language reason and fix (built from the call site only: never the SDK's message,
 * which can carry request IDs and account details), and transient ones as `LlmBusy`. Anything else (model
 * errors, aborts) returns null and is thrown as it was.
 */
export const classifyBedrockError = (error: unknown, site: CallSite): LlmUnavailable | null => {
  const name = nameOf(error);
  const message = messageOf(error);
  if (BUSY_ERRORS.has(name) || (name === 'Error' && /unable to process your request/i.test(message))) return new LlmBusy();
  switch (name) {
    // The SDK's credential chain: the SSO token provider and the credential providers.
    case 'TokenProviderError':
    case 'CredentialsProviderError':
    case 'ProviderError':
      if (/could not load credentials from any providers/i.test(message)) {
        return new LlmUnavailable(
          'No AWS credentials',
          `Set AWS_PROFILE and run \`aws sso login\`, or give the server an IAM role with Bedrock access`,
        );
      }
      if (/expired|sso|re-?authenticate|aws login/i.test(message)) {
        return new LlmUnavailable('AWS sign-in expired', signInFix(site.profile));
      }
      return unloadedCredentials(site.profile);
    case 'ExpiredTokenException':
    case 'ExpiredToken':
      return new LlmUnavailable('AWS sign-in expired', signInFix(site.profile));
    case 'UnrecognizedClientException':
      return new LlmUnavailable('AWS credentials are not valid', signInFix(site.profile));
    case 'AccessDeniedException':
      return new LlmUnavailable(
        `No access to the Bedrock model ${shownModelId(site.model.id)}`,
        `Ask an admin to allow bedrock:InvokeModel for it and to enable model access in the Bedrock console (${site.region}); the model is set by ${site.model.configKey}`,
      );
    // Model access not granted yet (or Anthropic's first-use form not submitted), or no such model.
    case 'ResourceNotFoundException':
      return new LlmUnavailable(`The Bedrock model ${shownModelId(site.model.id)} isn't found or enabled`, modelFix(site));
    case 'ValidationException':
      // Only a wrong or unsupported model ID needs a person (e.g. "The provided model identifier is
      // invalid", "Invocation of model ID … with on-demand throughput isn't supported"); other
      // validation errors are request problems and stay ordinary failures.
      if (MODEL_ID_INVALID.test(message)) {
        return new LlmUnavailable(`The Bedrock model ${shownModelId(site.model.id)} isn't valid here`, modelFix(site));
      }
      return null;
    default:
      return null;
  }
};

/**
 * The LLM port on Amazon Bedrock (Converse API), with slop's IAM role or the developer's AWS
 * profile. Token usage is reported so it can be priced for the spend line on the board. Credential
 * and access failures throw `LlmUnavailable`, transient ones `LlmBusy`; other failures are rethrown unchanged.
 */
export class BedrockLlm implements Llm {
  private readonly client: BedrockRuntimeClient;
  private readonly site: CallSite;

  private readonly modelId: string;

  constructor(
    model: BedrockModel,
    region: string,
    private readonly onUsage: (usage: { model: string; input: number; output: number }) => void = () => undefined,
    /** Sampling temperature; null sends none (Sonnet and Opus 5.5 refuse non-default sampling values). */
    private readonly temperature: number | null = 0,
  ) {
    this.modelId = model.id;
    this.client = new BedrockRuntimeClient({ region, ...BEDROCK_CLIENT_RETRY });
    this.site = { model, region, profile: process.env.AWS_PROFILE };
  }

  async complete(request: LlmRequest): Promise<string> {
    let response;
    try {
      response = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: request.system }],
          messages: [{ role: 'user', content: [{ text: request.prompt }] }],
          inferenceConfig:
            this.temperature === null
              ? { maxTokens: request.maxTokens }
              : { maxTokens: request.maxTokens, temperature: this.temperature },
        }),
        // The SDK has no request timeout by default; the caller's deadline ends a stalled call.
        request.signal === undefined ? {} : { abortSignal: request.signal },
      );
    } catch (error) {
      throw classifyBedrockError(error, this.site) ?? error;
    }
    this.onUsage({
      model: this.modelId,
      input: response.usage?.inputTokens ?? 0,
      output: response.usage?.outputTokens ?? 0,
    });
    return (response.output?.message?.content ?? []).map((block) => block.text ?? '').join('');
  }
}
