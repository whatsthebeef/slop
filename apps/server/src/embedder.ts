import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { EMBEDDING_DIMENSIONS } from '@slop/core';
import type { Embedder } from '@slop/core';
import { BEDROCK_CLIENT_RETRY, classifyBedrockError } from './llm.js';
import type { BedrockModel } from './llm.js';

/** Titan embeddings take one text per call, so a batch runs a few calls at a time. */
const CONCURRENCY = 4;

/** The vector in a Titan V2 response, if the body has one of the expected size. */
const vectorOf = (body: unknown): number[] | null => {
  if (typeof body !== 'object' || body === null || !('embedding' in body) || !Array.isArray(body.embedding)) return null;
  const numbers = body.embedding.filter((x): x is number => typeof x === 'number');
  return numbers.length === EMBEDDING_DIMENSIONS && numbers.length === body.embedding.length ? numbers : null;
};

/**
 * The embedding port on Amazon Bedrock (Titan Text Embeddings V2, 1024 dimensions, normalised), with the same
 * credentials as the LLMs. Credential and access failures throw `LlmUnavailable`; other failures are rethrown.
 */
export class BedrockEmbedder implements Embedder {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly model: string;
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly bedrockModel: BedrockModel,
    private readonly region: string,
  ) {
    this.model = bedrockModel.id;
    this.client = new BedrockRuntimeClient({ region, ...BEDROCK_CLIENT_RETRY });
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const vectors: number[][] = new Array<number[]>(texts.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < texts.length; i = next++) vectors[i] = await this.embedOne(texts[i] ?? '', signal);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));
    return vectors;
  }

  private async embedOne(text: string, signal: AbortSignal | undefined): Promise<number[]> {
    let body: Uint8Array;
    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: this.model,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({ inputText: text, dimensions: this.dimensions, normalize: true }),
        }),
        signal === undefined ? {} : { abortSignal: signal },
      );
      body = response.body;
    } catch (error) {
      throw classifyBedrockError(error, { model: this.bedrockModel, region: this.region, profile: process.env.AWS_PROFILE }) ?? error;
    }
    const vector = vectorOf(JSON.parse(new TextDecoder().decode(body)));
    if (vector === null) throw new Error(`The embedding model ${this.model} returned no ${String(this.dimensions)}-dimension vector`);
    return vector;
  }
}
