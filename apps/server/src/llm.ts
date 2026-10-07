import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { LlmUnavailable } from '@slop/core';
import type { Llm, LlmRequest } from '@slop/core';

/** Where the failing call ran, to make the fix concrete. */
interface CallSite {
  readonly modelId: string;
  readonly region: string;
  readonly profile: string | undefined;
}

const signInFix = (profile: string | undefined): string =>
  `Run \`aws sso login${profile === undefined ? '' : ` --profile ${profile}`}\` on the server, or ask an admin to lengthen the IAM Identity Center session`;

const nameOf = (error: unknown): string =>
  error instanceof Error ? error.name : '';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : '');

/**
 * Credential and access failures, which no retry fixes until a person acts, as `LlmUnavailable`
 * with a plain-language reason and fix (built from the call site only: never the SDK's message,
 * which can carry request IDs and account details). Anything else (throttling, timeouts, model
 * errors, aborts) returns null and is thrown as it was.
 */
export const classifyBedrockError = (error: unknown, site: CallSite): LlmUnavailable | null => {
  const name = nameOf(error);
  const message = messageOf(error);
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
      return new LlmUnavailable("AWS credentials couldn't be loaded", signInFix(site.profile));
    case 'ExpiredTokenException':
    case 'ExpiredToken':
      return new LlmUnavailable('AWS sign-in expired', signInFix(site.profile));
    case 'UnrecognizedClientException':
      return new LlmUnavailable('AWS credentials are not valid', signInFix(site.profile));
    case 'AccessDeniedException':
      return new LlmUnavailable(
        `No access to the Bedrock model ${site.modelId}`,
        `Ask an admin to allow bedrock:InvokeModel for it and to enable model access in the Bedrock console (${site.region})`,
      );
    default:
      return null;
  }
};

/**
 * The LLM port on Amazon Bedrock (Converse API), with slop's IAM role or the developer's AWS
 * profile. Token usage is reported so it can be priced for the spend line on the board. Credential
 * and access failures throw `LlmUnavailable`; other failures are rethrown unchanged.
 */
export class BedrockLlm implements Llm {
  private readonly client: BedrockRuntimeClient;
  private readonly site: CallSite;

  constructor(
    private readonly modelId: string,
    region: string,
    private readonly onUsage: (usage: { model: string; input: number; output: number }) => void = () => undefined,
    /** Sampling temperature; null sends none (Sonnet and Opus 5.5 refuse non-default sampling values). */
    private readonly temperature: number | null = 0,
  ) {
    this.client = new BedrockRuntimeClient({ region });
    this.site = { modelId, region, profile: process.env.AWS_PROFILE };
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
