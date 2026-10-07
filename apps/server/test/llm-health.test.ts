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
    const health = new LlmHealth((_model, s) => changes.push(s), () => `2026-10-07T00:00:0${String(tick++)}.000Z`);
    return { health, changes };
  };

  it('starts unknown, goes ok on success and down on LlmUnavailable, telling the listener once per change', async () => {
    const { health, changes } = setup();
    const a = scripted();
    const tracked = health.track(a.llm, 'opus');
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

  it('leaves the state alone on ordinary failures and tracks each model on its own', async () => {
    const { health, changes } = setup();
    const intake = scripted();
    const draft = scripted();
    const trackedIntake = health.track(intake.llm, 'haiku');
    const trackedDraft = health.track(draft.llm, 'opus');

    const throttled = new Error('Too many requests');
    draft.fail(throttled);
    await expect(trackedDraft.complete(REQUEST)).rejects.toBe(throttled);
    expect(health.state()).toEqual({ state: 'unknown' });

    draft.fail(new LlmUnavailable('No access to the Bedrock model opus', 'Enable it'));
    await expect(trackedDraft.complete(REQUEST)).rejects.toBeInstanceOf(LlmUnavailable);
    draft.fail(throttled);
    await expect(trackedDraft.complete(REQUEST)).rejects.toBe(throttled);
    expect(health.isDown(['opus'])).toBe(true);

    // Intake working says nothing about the KB model: no flapping, and the worst state is reported.
    await trackedIntake.complete(REQUEST);
    await trackedIntake.complete(REQUEST);
    expect(health.isDown(['opus'])).toBe(true);
    expect(health.isDown(['haiku'])).toBe(false);
    expect(health.isDown()).toBe(true);
    expect(health.state()).toMatchObject({ state: 'down', reason: 'No access to the Bedrock model opus' });
    expect(changes.map((c) => c.state)).toEqual(['down', 'ok']);

    draft.succeed();
    await trackedDraft.complete(REQUEST);
    expect(health.isDown()).toBe(false);
    expect(health.state()).toMatchObject({ state: 'ok' });
  });
});
