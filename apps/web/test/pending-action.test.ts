import { describe, expect, it, vi } from 'vitest';
import { PENDING_TIMEOUT_MS, QUEUED_SETTLE_MS, isPending, isSettling, startAction } from '../src/lib/pending-action';
import type { PendingAction } from '../src/lib/pending-action';

const clicked: PendingAction = { action: 'start', version: 3, at: 1000 };
const at3 = { version: 3 };
const at4 = { version: 4, provisioning: 'ok' };

describe('pending action', () => {
  it('lasts until the glob version moves', () => {
    expect(isPending(clicked, at3, 2000)).toBe(true);
    expect(isPending(clicked, at4, 2000)).toBe(false);
  });

  it('gives up after the timeout', () => {
    expect(isPending(clicked, at3, 1000 + PENDING_TIMEOUT_MS - 1)).toBe(true);
    expect(isPending(clicked, at3, 1000 + PENDING_TIMEOUT_MS)).toBe(false);
  });

  it('is not pending when nothing was clicked', () => {
    expect(isPending(null, at3, 2000)).toBe(false);
  });

  it('stays pending after the request succeeds, until the glob changes', async () => {
    const set = vi.fn();
    expect(await startAction(null, false, clicked, at3, () => Promise.resolve(true), set)).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(clicked);
  });

  it('clears the pending state when the action fails or throws', async () => {
    const set = vi.fn();
    await startAction(null, false, clicked, at3, () => Promise.resolve(false), set);
    expect(set).toHaveBeenLastCalledWith(null);
    await expect(startAction(null, false, clicked, at3, () => Promise.reject(new Error('x')), set)).rejects.toThrow('x');
    expect(set).toHaveBeenLastCalledWith(null);
  });

  it('ignores a second click while pending or in flight', async () => {
    const send = vi.fn(() => Promise.resolve(true));
    const set = vi.fn();
    expect(await startAction(clicked, false, { ...clicked, at: 1500 }, at3, send, set)).toBe(false);
    expect(await startAction(null, true, clicked, at3, send, set)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('stays pending across the version change while provisioning is pending, then ends', () => {
    expect(isPending(clicked, { version: 4, provisioning: 'pending' }, 2000)).toBe(true);
    expect(isPending(clicked, { version: 5, provisioning: 'ok', currentRun: { state: 'active', queuedAt: new Date(0).toISOString() } }, 2000)).toBe(false);
    expect(isPending(clicked, { version: 5, provisioning: 'failed' }, 2000)).toBe(false);
  });

  it('stays pending while the run was queued moments ago', () => {
    const queuedAt = new Date(1000).toISOString();
    const glob = { version: 4, provisioning: 'ok', currentRun: { state: 'queued', queuedAt } };
    expect(isSettling(glob, 1000 + QUEUED_SETTLE_MS - 1)).toBe(true);
    expect(isSettling(glob, 1000 + QUEUED_SETTLE_MS)).toBe(false);
    expect(isPending(clicked, glob, 2000)).toBe(true);
  });

  it('gives up after the timeout even while setup is pending', () => {
    expect(isPending(clicked, { version: 4, provisioning: 'pending' }, 1000 + PENDING_TIMEOUT_MS)).toBe(false);
  });
});
