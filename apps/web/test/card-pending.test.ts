import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_PENDING_MS, mergeOutcomeText, runCardAction, workingLabel } from '../src/lib/card-pending';

afterEach(() => vi.useRealTimers());

const defer = () => {
  let resolve: (ok: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('card pending', () => {
  it('names the action in the present participle', () => {
    expect(workingLabel('start')).toBe('Starting…');
    expect(workingLabel('pick_up')).toBe('Picking up…');
    expect(workingLabel('delete')).toBe('Working…');
  });

  it('shows pending before the request answers and clears it on success', async () => {
    const set = vi.fn();
    const request = defer();
    const run = runCardAction(new Set(), 's1t1', 'start', () => request.promise, set, vi.fn());
    expect(set).toHaveBeenCalledWith('s1t1', 'start');
    request.resolve(true);
    expect(await run).toBe(true);
    expect(set).toHaveBeenLastCalledWith('s1t1', null);
  });

  it('clears pending when the action fails or throws', async () => {
    const set = vi.fn();
    expect(await runCardAction(new Set(), 'a', 'start', () => Promise.resolve(false), set, vi.fn())).toBe(false);
    expect(set).toHaveBeenLastCalledWith('a', null);
    await expect(runCardAction(new Set(), 'a', 'start', () => Promise.reject(new Error('x')), set, vi.fn())).rejects.toThrow('x');
    expect(set).toHaveBeenLastCalledWith('a', null);
  });

  it('ignores a second action on the same glob while one is in flight, but not on another glob', async () => {
    const inFlight = new Set<string>();
    const request = defer();
    const work = vi.fn(() => request.promise);
    const first = runCardAction(inFlight, 'a', 'start', work, vi.fn(), vi.fn());
    expect(await runCardAction(inFlight, 'a', 'start', work, vi.fn(), vi.fn())).toBeNull();
    expect(work).toHaveBeenCalledTimes(1);
    const other = vi.fn(() => Promise.resolve(true));
    expect(await runCardAction(inFlight, 'b', 'start', other, vi.fn(), vi.fn())).toBe(true);
    request.resolve(true);
    await first;
    expect(await runCardAction(inFlight, 'a', 'start', other, vi.fn(), vi.fn())).toBe(true);
  });

  it('clears pending after the timeout and says so', () => {
    vi.useFakeTimers();
    const set = vi.fn();
    const onSlow = vi.fn();
    const inFlight = new Set<string>();
    const run = runCardAction(inFlight, 'a', 'start', () => new Promise<boolean>(() => undefined), set, onSlow);
    void run;
    vi.advanceTimersByTime(CARD_PENDING_MS - 1);
    expect(onSlow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSlow).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenLastCalledWith('a', null);
    expect(inFlight.has('a')).toBe(false);
  });
});

describe('mergeOutcomeText', () => {
  it('says which happened: merged, armed, merging, cancelled or why it failed', () => {
    expect(mergeOutcomeText('merge', { status: 'reviewing' })).toBe('Merged');
    expect(mergeOutcomeText('merge', { status: 'pr_open', mergeMode: 'when_green' })).toBe('Will merge when checks pass');
    expect(mergeOutcomeText('merge', { status: 'merging' })).toBe('Merging…');
    expect(mergeOutcomeText('merge', { status: 'failed', failure: { reason: 'conflict in a.ts' } })).toBe("Can't merge: conflict in a.ts");
    expect(mergeOutcomeText('cancel_merge', { status: 'pr_open' })).toBe('Merge cancelled');
    expect(mergeOutcomeText('start', { status: 'in_progress' })).toBeNull();
  });
});
