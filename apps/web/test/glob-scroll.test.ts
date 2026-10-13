import { describe, expect, it, vi } from 'vitest';
import { findSection, scrollWhenReady } from '../src/lib/glob-scroll';

const fakeTimers = () => {
  let t = 0;
  const queue: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => t,
    set: (fn: () => void, ms: number) => {
      const item = { at: t + ms, fn };
      queue.push(item);
      return item;
    },
    clear: (h: unknown) => {
      const i = queue.indexOf(h as (typeof queue)[number]);
      if (i >= 0) queue.splice(i, 1);
    },
    advance: (ms: number) => {
      const end = t + ms;
      while (queue.length > 0) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (next === undefined || next.at > end) break;
        queue.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
};

const element = () => {
  const spy = vi.fn();
  return { el: { scrollIntoView: spy } as unknown as HTMLElement, spy };
};

describe('scrollWhenReady', () => {
  it('scrolls the section to the top as soon as it is there, once', () => {
    const { el, spy } = element();
    const timers = fakeTimers();
    scrollWhenReady(() => el, 3000, timers);
    timers.advance(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ block: 'start' });
  });

  it('waits for a section whose data is still loading', () => {
    const { el, spy } = element();
    const timers = fakeTimers();
    let ready = false;
    scrollWhenReady(() => (ready ? el : null), 3000, timers);
    timers.advance(500);
    expect(spy).not.toHaveBeenCalled();
    ready = true;
    timers.advance(200);
    expect(spy).toHaveBeenCalledTimes(1);
    timers.advance(5000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a section that never renders, and stops waiting', () => {
    const find = vi.fn(() => null);
    const timers = fakeTimers();
    scrollWhenReady(find, 3000, timers);
    timers.advance(10000);
    const calls = find.mock.calls.length;
    timers.advance(10000);
    expect(find.mock.calls.length).toBe(calls);
  });

  it('does not scroll after being cancelled', () => {
    const { el, spy } = element();
    const timers = fakeTimers();
    let ready = false;
    const cancel = scrollWhenReady(() => (ready ? el : null), 3000, timers);
    cancel();
    ready = true;
    timers.advance(1000);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('findSection', () => {
  it('finds a rendered section and ignores an empty or missing one', () => {
    const full = { childElementCount: 1 } as HTMLElement;
    const empty = { childElementCount: 0 } as HTMLElement;
    const root = (el: HTMLElement | null) => ({ querySelector: () => el }) as unknown as ParentNode;
    expect(findSection(root(full), 'findings')).toBe(full);
    expect(findSection(root(empty), 'findings')).toBeNull();
    expect(findSection(root(null), 'findings')).toBeNull();
  });
});
