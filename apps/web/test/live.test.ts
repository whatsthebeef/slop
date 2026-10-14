import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectBoardStream, reconnectDelay, SILENCE_MS, trailing } from '../src/lib/live';
import type { LiveState } from '../src/lib/live';

describe('trailing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once after a burst, a delay after the last call', () => {
    const work = vi.fn();
    const { call } = trailing(work, 2_000);
    call();
    vi.advanceTimersByTime(1_500);
    call();
    vi.advanceTimersByTime(1_500);
    expect(work).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(work).toHaveBeenCalledTimes(1);
    call();
    vi.advanceTimersByTime(2_000);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('does nothing once cancelled', () => {
    const work = vi.fn();
    const { call, cancel } = trailing(work, 2_000);
    call();
    cancel();
    vi.advanceTimersByTime(5_000);
    expect(work).not.toHaveBeenCalled();
  });
});

describe('reconnectDelay', () => {
  it('doubles from one second', () => {
    expect([0, 1, 2, 3].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000]);
  });

  it('stops growing at thirty seconds', () => {
    expect(reconnectDelay(5)).toBe(30_000);
    expect(reconnectDelay(50)).toBe(30_000);
  });
});

describe('connectBoardStream', () => {
  class FakeEventSource {
    static readonly CLOSED = 2;
    static instances: FakeEventSource[] = [];
    readyState = 1;
    onerror: (() => void) | null = null;
    private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    close() {
      this.readyState = FakeEventSource.CLOSED;
    }
    emit(type: string, data = '{}') {
      for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent<string>);
    }
  }

  let visibility: 'visible' | 'hidden';
  let visibilityListeners: (() => void)[];
  let states: LiveState[];
  let reconnects: number;
  let hints: unknown[];

  const connect = () =>
    connectBoardStream(1, {
      onHint: (hint) => hints.push(hint),
      onReconnect: () => (reconnects += 1),
      onState: (state) => states.push(state),
    });
  const setVisibility = (next: 'visible' | 'hidden') => {
    visibility = next;
    for (const listener of visibilityListeners) listener();
  };
  const last = () => {
    const stream = FakeEventSource.instances.at(-1);
    if (stream === undefined) throw new Error('no stream was opened');
    return stream;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    visibility = 'visible';
    visibilityListeners = [];
    states = [];
    reconnects = 0;
    hints = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (_: string, listener: () => void) => visibilityListeners.push(listener),
      removeEventListener: (_: string, listener: () => void) => {
        visibilityListeners = visibilityListeners.filter((l) => l !== listener);
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not reload on the first ready of a page loaded visible, but does on a later one', () => {
    const dispose = connect();
    last().emit('ready');
    expect(reconnects).toBe(0);
    expect(states).toEqual(['live']);
    last().emit('ready');
    expect(reconnects).toBe(1);
    dispose();
  });

  it('reloads on the first ready of a page loaded hidden, once visible', () => {
    visibility = 'hidden';
    const dispose = connect();
    expect(states).toEqual(['paused']);
    expect(FakeEventSource.instances).toHaveLength(0);
    setVisibility('visible');
    last().emit('ready');
    expect(reconnects).toBe(1);
    last().emit('ready');
    expect(reconnects).toBe(2);
    dispose();
  });

  it('reloads when the tab comes back after being hidden', () => {
    const dispose = connect();
    last().emit('ready');
    setVisibility('hidden');
    expect(last().readyState).toBe(FakeEventSource.CLOSED);
    setVisibility('visible');
    expect(FakeEventSource.instances).toHaveLength(2);
    last().emit('ready');
    expect(reconnects).toBe(1);
    dispose();
  });

  it('closes and reopens a stream that is silent for 60 s, and reloads on its ready', () => {
    const dispose = connect();
    const first = last();
    first.emit('ready');
    vi.advanceTimersByTime(SILENCE_MS - 1);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(states).toEqual(['live', 'reconnecting']);
    last().emit('ready');
    expect(reconnects).toBe(1);
    expect(states).toEqual(['live', 'reconnecting', 'live']);
    dispose();
  });

  it('reloads after a silence even when the stream never became ready', () => {
    const dispose = connect();
    vi.advanceTimersByTime(SILENCE_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
    last().emit('ready');
    expect(reconnects).toBe(1);
    dispose();
  });

  it('keeps the stream open while pings and hints arrive', () => {
    const dispose = connect();
    last().emit('ready');
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(SILENCE_MS - 1);
      last().emit(i % 2 === 0 ? 'ping' : 'hint', i % 2 === 0 ? '{}' : '{"kind":"board.changed"}');
    }
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(hints).toEqual([{ kind: 'board.changed' }, { kind: 'board.changed' }]);
    dispose();
  });

  it('stops the silence timer when hidden and on dispose', () => {
    const dispose = connect();
    last().emit('ready');
    setVisibility('hidden');
    vi.advanceTimersByTime(SILENCE_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(1);
    setVisibility('visible');
    dispose();
    vi.advanceTimersByTime(SILENCE_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('reopens a stream the browser closed for good, with backoff', () => {
    const dispose = connect();
    last().emit('ready');
    last().readyState = FakeEventSource.CLOSED;
    last().onerror?.();
    expect(states).toEqual(['live', 'reconnecting']);
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    last().emit('ready');
    expect(reconnects).toBe(1);
    dispose();
  });
});
