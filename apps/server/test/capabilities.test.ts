import type { Capabilities } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { CapabilityReader, CapabilityWatch } from '../src/capabilities.js';
import type { CapabilitySwitches } from '../src/capabilities.js';

const switches = (patch: Partial<CapabilitySwitches> = {}): CapabilitySwitches => ({
  bucket: null,
  attachmentQueueConfigured: false,
  slackConfigured: false,
  codeIndexRuns: false,
  deployResultsConfigured: false,
  atfClients: null,
  ...patch,
});

describe('CapabilityReader', () => {
  it('reports everything off when nothing is configured, without probing', async () => {
    expect(await new CapabilityReader(switches()).read()).toEqual({ fileAttachments: false, attachmentEvents: false, slack: false, codeIndex: false, deployResults: false, atfClientCredentials: false });
  });

  it('reports the configured switches', async () => {
    const read = await new CapabilityReader(switches({ attachmentQueueConfigured: true, slackConfigured: true, codeIndexRuns: true, deployResultsConfigured: true })).read();
    expect(read).toEqual({ fileAttachments: false, attachmentEvents: true, slack: true, codeIndex: true, deployResults: true, atfClientCredentials: false });
  });

  it('turns file attachments on only when the bucket answers, caching the answer for a minute', async () => {
    let calls = 0;
    let answer = true;
    let clock = 0;
    const reader = new CapabilityReader(switches({ bucket: { unreachableReason: () => Promise.resolve(++calls > 0 && answer ? null : 'bucket denied: AccessDenied') } }), () => clock);
    expect((await reader.read()).fileAttachments).toBe(true);
    answer = false;
    clock = 30_000;
    expect((await reader.read()).fileAttachments).toBe(true);
    expect(calls).toBe(1);
    clock = 61_000;
    expect((await reader.read()).fileAttachments).toBe(false);
    expect(calls).toBe(2);
  });

  it('counts a probe that throws as off', async () => {
    const reader = new CapabilityReader(switches({ bucket: { unreachableReason: () => Promise.reject(new Error('boom')) } }));
    expect((await reader.read()).fileAttachments).toBe(false);
    expect(await reader.reasons()).toEqual({ fileAttachments: 'timeout', atfClientCredentials: 'Cognito user pool not configured' });
  });
});

describe('CapabilityReader ATF client credentials', () => {
  it('is on only while the Cognito probe finds the permission and scopes, cached for a minute, and says why when off', async () => {
    let reason: string | null = null;
    let calls = 0;
    let clock = 0;
    const reader = new CapabilityReader(
      switches({ atfClients: { unavailableReason: () => Promise.resolve(++calls > 0 ? reason : null) } }),
      () => clock,
    );
    expect((await reader.read()).atfClientCredentials).toBe(true);
    reason = 'the instance role may not manage Cognito app clients';
    clock = 30_000;
    expect((await reader.read()).atfClientCredentials).toBe(true);
    expect(calls).toBe(1);
    clock = 61_000;
    expect((await reader.read()).atfClientCredentials).toBe(false);
    expect((await reader.reasons()).atfClientCredentials).toBe('the instance role may not manage Cognito app clients');
  });

  it('counts a probe that throws as off', async () => {
    const reader = new CapabilityReader(switches({ atfClients: { unavailableReason: () => Promise.reject(new Error('boom')) } }));
    expect((await reader.read()).atfClientCredentials).toBe(false);
  });
});

describe('CapabilityReader.reasons', () => {
  it('says why file attachments are off, and nothing when they are on', async () => {
    const unconfigured = { fileAttachments: 'bucket not configured', atfClientCredentials: 'Cognito user pool not configured' };
    expect(await new CapabilityReader(switches()).reasons()).toEqual(unconfigured);
    const denied = new CapabilityReader(switches({ bucket: { unreachableReason: () => Promise.resolve('bucket denied: AccessDenied') } }));
    expect(await denied.reasons()).toEqual({ ...unconfigured, fileAttachments: 'bucket denied: AccessDenied' });
    const on = new CapabilityReader(switches({ bucket: { unreachableReason: () => Promise.resolve(null) }, atfClients: { unavailableReason: () => Promise.resolve(null) } }));
    expect(await on.reasons()).toEqual({});
  });
});

describe('CapabilityWatch', () => {
  const boards = () => Promise.resolve([1, 2]);

  it('ticks each board against what the reader says and adds up what was ticked', async () => {
    const seen: [number, Capabilities][] = [];
    const watch = new CapabilityWatch(
      boards,
      { tickCapabilitySteps: (boardId, capabilities) => (seen.push([boardId, capabilities]), Promise.resolve(boardId)) },
      { read: () => Promise.resolve({ fileAttachments: true }) },
      () => undefined,
    );
    expect(await watch.sweep()).toBe(3);
    expect(seen).toEqual([
      [1, { fileAttachments: true }],
      [2, { fileAttachments: true }],
    ]);
  });

  it('logs a failure and carries on at the next sweep', async () => {
    const logged: string[] = [];
    let fail = true;
    const watch = new CapabilityWatch(
      boards,
      { tickCapabilitySteps: () => Promise.resolve(1) },
      { read: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve({})) },
      (task, message) => logged.push(`${task}: ${message}`),
    );
    expect(await watch.sweep()).toBe(0);
    expect(logged).toEqual(['capabilities: boom']);
    fail = false;
    expect(await watch.sweep()).toBe(2);
  });
});
