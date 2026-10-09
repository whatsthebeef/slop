import { LlmBusy, LlmUnavailable } from '@slop/core';
import type { Embedder, Llm } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { BUSY_WARNING_COUNT, LlmHealth } from '../src/llm-health.js';
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

  it('tracks an embedder like an LLM: ok on success, down on LlmUnavailable, untouched by ordinary failures', async () => {
    const { health, changes } = setup();
    let next: () => Promise<number[][]> = () => Promise.resolve([[1]]);
    const embedder: Embedder = { model: 'titan', dimensions: 1024, embed: () => next() };
    const tracked = health.trackEmbedder(embedder, 'titan');
    expect(tracked.model).toBe('titan');
    expect(tracked.dimensions).toBe(1024);

    expect(await tracked.embed(['a'])).toEqual([[1]]);
    expect(health.isDown(['titan'])).toBe(false);

    const throttled = new Error('Too many requests');
    next = () => Promise.reject(throttled);
    await expect(tracked.embed(['a'])).rejects.toBe(throttled);
    expect(health.isDown(['titan'])).toBe(false);

    const denied = new LlmUnavailable('No access to the Bedrock model titan', 'Enable it');
    next = () => Promise.reject(denied);
    await expect(tracked.embed(['a'])).rejects.toBe(denied);
    expect(health.isDown(['titan'])).toBe(true);
    expect(health.state()).toMatchObject({ state: 'down', reason: 'No access to the Bedrock model titan' });

    next = () => Promise.resolve([[2]]);
    await tracked.embed(['a']);
    expect(health.isDown(['titan'])).toBe(false);
    expect(changes.map((c) => c.state)).toEqual(['ok', 'down', 'ok']);
  });

  it('ignores busy answers: the model stays ok, and many in a row warn until the next success', async () => {
    const changes: LlmHealthState[] = [];
    const warnings: boolean[] = [];
    const health = new LlmHealth((_model, s) => changes.push(s), () => '2026-10-07T00:00:00.000Z', (_model, on) => warnings.push(on));
    const opus = scripted();
    const tracked = health.track(opus.llm, 'opus');
    await tracked.complete(REQUEST);
    opus.fail(new LlmBusy());
    for (let i = 0; i < BUSY_WARNING_COUNT - 1; i++) await expect(tracked.complete(REQUEST)).rejects.toBeInstanceOf(LlmBusy);
    expect(health.state()).toMatchObject({ state: 'ok' });
    expect(warnings).toEqual([]);
    await expect(tracked.complete(REQUEST)).rejects.toBeInstanceOf(LlmBusy);
    expect(health.isDown(['opus'])).toBe(false);
    expect(health.state()).toMatchObject({ state: 'ok' });
    expect(changes).toHaveLength(1);
    expect(warnings).toEqual([true]);
    opus.succeed();
    await tracked.complete(REQUEST);
    expect(warnings).toEqual([true, false]);
  });
});
