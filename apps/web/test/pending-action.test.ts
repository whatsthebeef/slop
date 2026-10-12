import { describe, expect, it, vi } from 'vitest';
import { PENDING_TIMEOUT_MS, isPending, startAction } from '../src/lib/pending-action';
import type { PendingAction } from '../src/lib/pending-action';

const clicked: PendingAction = { action: 'start', version: 3, at: 1000 };

describe('pending action', () => {
  it('lasts until the glob version moves', () => {
    expect(isPending(clicked, 3, 2000)).toBe(true);
    expect(isPending(clicked, 4, 2000)).toBe(false);
  });

  it('gives up after the timeout', () => {
    expect(isPending(clicked, 3, 1000 + PENDING_TIMEOUT_MS - 1)).toBe(true);
    expect(isPending(clicked, 3, 1000 + PENDING_TIMEOUT_MS)).toBe(false);
  });

  it('is not pending when nothing was clicked', () => {
    expect(isPending(null, 3, 2000)).toBe(false);
  });

  it('stays pending after the request succeeds, until the glob changes', async () => {
    const set = vi.fn();
    expect(await startAction(null, false, clicked, () => Promise.resolve(true), set)).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(clicked);
  });

  it('clears the pending state when the action fails or throws', async () => {
    const set = vi.fn();
    await startAction(null, false, clicked, () => Promise.resolve(false), set);
    expect(set).toHaveBeenLastCalledWith(null);
    await expect(startAction(null, false, clicked, () => Promise.reject(new Error('x')), set)).rejects.toThrow('x');
    expect(set).toHaveBeenLastCalledWith(null);
  });

  it('ignores a second click while pending or in flight', async () => {
    const send = vi.fn(() => Promise.resolve(true));
    const set = vi.fn();
    expect(await startAction(clicked, false, { ...clicked, at: 1500 }, send, set)).toBe(false);
    expect(await startAction(null, true, clicked, send, set)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
