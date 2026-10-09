import { hash } from '../app/text-hash.js';
import { LlmUnavailable } from '../app/intake-service.js';
import type { Embedder } from '../ports.js';

const DIMENSIONS = 1024;

/**
 * A deterministic embedder for tests: each word lands on one of 1024 dimensions (the hashing trick), and the vector is
 * scaled to unit length, so texts sharing words are close and unrelated texts are not. `unavailable` makes the next
 * calls throw as an embedder without credentials does.
 */
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-embed';
  readonly dimensions = DIMENSIONS;
  /** Set to make `embed` throw `LlmUnavailable` until it is cleared. */
  unavailable: LlmUnavailable | null = null;
  /** Every batch of texts embedded, for tests. */
  readonly calls: (readonly string[])[] = [];

  embed(texts: readonly string[]): Promise<number[][]> {
    if (this.unavailable !== null) return Promise.reject(this.unavailable);
    this.calls.push(texts);
    return Promise.resolve(texts.map(vectorOf));
  }
}

export const vectorOf = (text: string): number[] => {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word === '') continue;
    const h = Number.parseInt(hash(word), 16);
    const slot = h % DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + (Math.floor(h / DIMENSIONS) % 2 === 0 ? 1 : -1);
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return norm === 0 ? vector : vector.map((x) => x / norm);
};
