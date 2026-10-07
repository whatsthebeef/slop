import { LlmUnavailable } from '@slop/core';
import type { IntegrationHealth } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { IntegrationRegistry } from '../src/integration-health.js';
import { LlmHealth } from '../src/llm-health.js';
import { TunnelWatch } from '../src/tunnel-health.js';

const REQUEST = { system: 's', prompt: 'p', maxTokens: 1 };

const setup = () => {
  const changes: IntegrationHealth[] = [];
  let tick = 0;
  const registry = new IntegrationRegistry(
    (h) => changes.push(h),
    () => `t${String(tick++)}`,
  );
  return { registry, changes };
};

describe('IntegrationRegistry', () => {
  it('reports each change once, keeps since across repeats, and treats a new reason as a change', () => {
    const { registry, changes } = setup();
    registry.markOk('github_app');
    expect(changes).toEqual([]);
    registry.markDown('github_app', 'bad', 'fix it');
    registry.markDown('github_app', 'bad', 'fix it');
    registry.markDown('github_app', 'worse', 'fix it');
    registry.markOk('github_app');
    registry.markOk('github_app');
    expect(changes.map((c) => [c.state, c.reason, c.since])).toEqual([
      ['down', 'bad', 't1'],
      ['down', 'worse', 't3'],
      ['ok', '', 't4'],
    ]);
    expect(registry.report()).toEqual([
      { id: 'github_app', state: 'ok', reason: '', fix: '', since: 't4' },
    ]);
  });

  it('follows LlmHealth for Bedrock, offering AWS sign-in only for an expired SSO session the server can redo', async () => {
    const { registry, changes } = setup();
    let fail: Error | null = new LlmUnavailable(
      'AWS sign-in expired',
      'Run `aws sso login`',
      'sso_expired',
    );
    const health = new LlmHealth(() => registry.syncBedrock(health.state(), true));
    const llm = health.track(
      { complete: () => (fail === null ? Promise.resolve('ok') : Promise.reject(fail)) },
      'haiku',
    );

    await expect(llm.complete(REQUEST)).rejects.toBeInstanceOf(LlmUnavailable);
    expect(registry.report()).toMatchObject([
      { id: 'bedrock', state: 'down', reason: 'AWS sign-in expired', action: 'aws_sign_in' },
    ]);

    // Signing in again and probing clears it without a restart.
    fail = null;
    await health.probe();
    expect(registry.report()).toMatchObject([{ id: 'bedrock', state: 'ok' }]);
    expect(changes.map((c) => c.state)).toEqual(['down', 'ok']);

    fail = new LlmUnavailable('No access to the Bedrock model m', 'Ask an admin');
    await health.probe();
    expect(registry.report()[0]).not.toHaveProperty('action');
  });

  it('offers no sign-in when the server cannot run it', () => {
    const { registry } = setup();
    registry.syncBedrock(
      { state: 'down', reason: 'AWS sign-in expired', fix: 'f', since: 's', code: 'sso_expired' },
      false,
    );
    expect(registry.report()[0]).not.toHaveProperty('action');
  });
});

describe('TunnelWatch', () => {
  it('is ok while ngrok lists the domain and degraded when it is missing or unreachable', async () => {
    const { registry } = setup();
    let body: unknown = { tunnels: [{ public_url: 'https://dev.ngrok.app' }] };
    const watch = new TunnelWatch('dev.ngrok.app', registry, () =>
      body === null ? Promise.reject(new Error('down')) : Promise.resolve(body),
    );
    await watch.check();
    expect(registry.report()).toMatchObject([{ id: 'tunnel', state: 'ok' }]);
    body = { tunnels: [] };
    await watch.check();
    expect(registry.report()).toMatchObject([{ id: 'tunnel', state: 'ok' }]);
    await watch.check();
    expect(registry.report()).toMatchObject([{ id: 'tunnel', state: 'degraded' }]);
    body = { tunnels: [{ public_url: 'https://dev.ngrok.app' }] };
    await watch.check();
    expect(registry.report()).toMatchObject([{ id: 'tunnel', state: 'ok' }]);
    body = null;
    await watch.check();
    await watch.check();
    expect(registry.report()).toMatchObject([{ id: 'tunnel', state: 'degraded' }]);
  });

  it('does not report a single miss, such as the first check before ngrok has started', async () => {
    const { registry, changes } = setup();
    let body: unknown = { tunnels: [] };
    const watch = new TunnelWatch('dev.ngrok.app', registry, () => Promise.resolve(body));
    await watch.check();
    body = { tunnels: [{ public_url: 'https://dev.ngrok.app' }] };
    await watch.check();
    expect(changes).toEqual([]);
    expect(registry.report()).toMatchObject([{ id: 'tunnel', state: 'ok' }]);
    body = { tunnels: [] };
    await watch.check();
    await watch.check();
    expect(changes).toMatchObject([{ id: 'tunnel', state: 'degraded' }]);
  });
});
