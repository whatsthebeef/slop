import { LlmUnavailable } from '@slop/core';
import type { Llm } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { LlmHealth } from '../src/llm-health.js';
import type { LlmHealthState } from '../src/llm-health.js';

const REQUEST = { system: 's', prompt: 'p', maxTokens: 10 };

/** An LLM whose next outcome the test sets. */
const scripted = () => {
  let next: () => Promise<string> = () => Promise.resolve('answer');
  const llm: Llm = { complete: () => next() };
  return {
    llm,
    succeed: () => (next = () => Promise.resolve('answer')),
    fail: (error: Error) => (next = () => Promise.reject(error)),
  };
};

describe('LlmHealth', () => {
  const setup = () => {
    const changes: LlmHealthState[] = [];
    let tick = 0;
    const health = new LlmHealth((s) => changes.push(s), () => `2026-10-07T00:00:0${String(tick++)}.000Z`);
    return { health, changes };
  };

  it('starts unknown, goes ok on success and down on LlmUnavailable, telling the listener once per change', async () => {
    const { health, changes } = setup();
    const a = scripted();
    const tracked = health.track(a.llm);
    expect(health.state()).toEqual({ state: 'unknown' });
    expect(health.isDown()).toBe(false);

    expect(await tracked.complete(REQUEST)).toBe('answer');
    await tracked.complete(REQUEST);
    expect(health.state()).toEqual({ state: 'ok', since: '2026-10-07T00:00:00.000Z' });

    const expired = new LlmUnavailable('AWS sign-in expired', 'Run `aws sso login`');
    a.fail(expired);
    await expect(tracked.complete(REQUEST)).rejects.toBe(expired);
    await expect(tracked.complete(REQUEST)).rejects.toBe(expired);
    expect(health.isDown()).toBe(true);
    expect(health.state()).toMatchObject({ state: 'down', reason: 'AWS sign-in expired', fix: 'Run `aws sso login`' });

    a.fail(new LlmUnavailable('No AWS credentials', 'Set AWS_PROFILE'));
    await expect(tracked.complete(REQUEST)).rejects.toBeInstanceOf(LlmUnavailable);

    a.succeed();
    await tracked.complete(REQUEST);
    expect(health.isDown()).toBe(false);
    expect(changes.map((c) => (c.state === 'down' ? c.reason : c.state))).toEqual([
      'ok',
      'AWS sign-in expired',
      'No AWS credentials',
      'ok',
    ]);
  });

  it('leaves the state alone on ordinary failures and shares one state across tracked instances', async () => {
    const { health, changes } = setup();
    const intake = scripted();
    const draft = scripted();
    const trackedIntake = health.track(intake.llm);
    const trackedDraft = health.track(draft.llm);

    const throttled = new Error('Too many requests');
    draft.fail(throttled);
    await expect(trackedDraft.complete(REQUEST)).rejects.toBe(throttled);
    expect(health.state()).toEqual({ state: 'unknown' });

    draft.fail(new LlmUnavailable('AWS sign-in expired', 'Run `aws sso login`'));
    await expect(trackedDraft.complete(REQUEST)).rejects.toBeInstanceOf(LlmUnavailable);
    draft.fail(throttled);
    await expect(trackedDraft.complete(REQUEST)).rejects.toBe(throttled);
    expect(health.isDown()).toBe(true);

    await trackedIntake.complete(REQUEST);
    expect(health.isDown()).toBe(false);
    expect(changes.map((c) => c.state)).toEqual(['down', 'ok']);
  });
});
