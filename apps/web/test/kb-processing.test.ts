import { describe, expect, it } from 'vitest';
import { nextTry } from '../src/lib/kb-processing';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('when a waiting learning is tried next', () => {
  it('is shortly when queued or due, and the backoff time after a failed attempt', () => {
    expect(nextTry({ processAfter: null, processingAttempts: 0, processingError: null }, NOW)).toBe('shortly');
    expect(nextTry({ processAfter: at(-1), processingAttempts: 1, processingError: 'x' }, NOW)).toBe('shortly');
    expect(nextTry({ processAfter: at(30_000), processingAttempts: 1, processingError: 'x' }, NOW)).toEqual(new Date(at(30_000)));
    expect(nextTry({ processAfter: at(60_000), processingAttempts: 2, processingError: 'x' }, NOW)).toEqual(new Date(at(60_000)));
  });

  it('is running while a claim holds the job for its lease, which is no retry time', () => {
    expect(nextTry({ processAfter: at(5 * 60_000), processingAttempts: 2, processingError: 'x' }, NOW)).toBe('running');
  });

  it('keeps a busy wait\'s own time, however far off', () => {
    expect(nextTry({ processAfter: at(15 * 60_000), processingAttempts: 1, processingError: 'Waiting: Bedrock busy (retrying at 12:15 UTC)' }, NOW)).toEqual(new Date(at(15 * 60_000)));
  });
});
