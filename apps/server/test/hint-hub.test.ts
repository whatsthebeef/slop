import type { Hint } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { HintHub } from '../src/notifier.js';

const hint: Hint = { kind: 'board.health', boardId: 1 };

describe('HintHub.subscribe', () => {
  it("a stale second unsubscribe doesn't drop listeners that subscribed since", () => {
    const hub = new HintHub();
    const unsubscribeA = hub.subscribe(1, () => undefined);
    unsubscribeA();
    const received: Hint[] = [];
    hub.subscribe(1, (h) => received.push(h));
    unsubscribeA();
    hub.publish(hint);
    expect(received).toEqual([hint]);
  });

  it('unsubscribing twice is harmless', () => {
    const hub = new HintHub();
    const received: Hint[] = [];
    hub.subscribe(1, (h) => received.push(h));
    const unsubscribeB = hub.subscribe(1, () => undefined);
    unsubscribeB();
    unsubscribeB();
    hub.publish(hint);
    expect(received).toHaveLength(1);
  });

  it('the last listener leaving clears the board entry', () => {
    const hub = new HintHub();
    const unsubscribe = hub.subscribe(1, () => undefined);
    unsubscribe();
    const broadcast: Hint[] = [];
    hub.tap((h) => broadcast.push(h));
    hub.broadcast('board.health');
    expect(broadcast).toEqual([]);
  });
});
