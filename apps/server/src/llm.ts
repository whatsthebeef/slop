import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Llm } from '@slop/core';

/**
 * The LLM port on Amazon Bedrock (Converse API), with slop's IAM role or the developer's AWS
 * profile. Token usage is reported so it can be priced for the spend line on the board.
 */
export class BedrockLlm implements Llm {
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly modelId: string,
    region: string,
    private readonly onUsage: (usage: { model: string; input: number; output: number }) => void = () => undefined,
  ) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async complete(request: { system: string; prompt: string; maxTokens: number }): Promise<string> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: request.system }],
        messages: [{ role: 'user', content: [{ text: request.prompt }] }],
        inferenceConfig: { maxTokens: request.maxTokens, temperature: 0 },
      }),
    );
    this.onUsage({
      model: this.modelId,
      input: response.usage?.inputTokens ?? 0,
      output: response.usage?.outputTokens ?? 0,
    });
    return (response.output?.message?.content ?? []).map((block) => block.text ?? '').join('');
  }
}
