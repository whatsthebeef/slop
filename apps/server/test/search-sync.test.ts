import type { Hint } from '@slop/core';
import { describe, expect, it } from 'vitest';
import { HintHub } from '../src/notifier.js';
import { marksBoardDirty, SAFETY_SYNC_MS, SearchSync } from '../src/jobs/search-sync.js';

class FakeIndexer {
  readonly calls: string[] = [];
  failAll: Error | null = null;
  syncBoard(boardId: number): Promise<unknown> {
    this.calls.push(`board ${String(boardId)}`);
    return Promise.resolve();
  }
  syncAll(): Promise<void> {
    this.calls.push('all');
    return this.failAll === null ? Promise.resolve() : Promise.reject(this.failAll);
  }
}

describe('SearchSync', () => {
  const setup = () => {
    const indexer = new FakeIndexer();
    const logs: string[] = [];
    let now = 1_000_000;
    const sync = new SearchSync(indexer, (task, message) => logs.push(`${task}: ${message}`), () => now);
    return { indexer, logs, sync, advance: (ms: number) => (now += ms) };
  };

  it('backfills every board on the first round, then syncs only the boards marked dirty', async () => {
    const { indexer, sync, advance } = setup();
    await sync.tick();
    expect(indexer.calls).toEqual(['all']);
    await sync.tick();
    expect(indexer.calls).toEqual(['all']);

    sync.mark(2);
    sync.mark(2);
    sync.mark(3);
    advance(10_000);
    await sync.tick();
    expect(indexer.calls).toEqual(['all', 'board 2', 'board 3']);
    // Synced boards are clean again.
    await sync.tick();
    expect(indexer.calls).toHaveLength(3);
  });

  it('runs a full sync every 15 minutes as a safety net, covering marked boards', async () => {
    const { indexer, sync, advance } = setup();
    await sync.tick();
    sync.mark(2);
    advance(SAFETY_SYNC_MS);
    await sync.tick();
    expect(indexer.calls).toEqual(['all', 'all']);
  });

  it('logs a failed sync and waits for the next full round instead of retrying every tick', async () => {
    const { indexer, logs, sync, advance } = setup();
    indexer.failAll = new Error('database down');
    await sync.tick();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('search: ');
    expect(logs[0]).toContain('database down');
    advance(10_000);
    await sync.tick();
    expect(indexer.calls).toEqual(['all']);
  });

  it('does nothing once stopped', async () => {
    const { indexer, sync } = setup();
    sync.stop();
    await sync.tick();
    expect(indexer.calls).toEqual([]);
  });
});

describe('marksBoardDirty and HintHub.tap', () => {
  it('marks the hints that change searchable material', () => {
    const hint = (kind: Hint['kind']): Hint => (kind === 'glob.changed' || kind === 'glob.deleted' ? { kind, boardId: 1, globId: 's1t1', version: 1 } : kind === 'glob.artifacts' || kind === 'glob.deploys' || kind === 'glob.findings' || kind === 'glob.reviews' ? { kind, boardId: 1, globId: 's1t1' } : { kind, boardId: 1 });
    expect(marksBoardDirty(hint('glob.artifacts'))).toBe(true);
    expect(marksBoardDirty(hint('glob.reviews'))).toBe(true);
    expect(marksBoardDirty(hint('glob.changed'))).toBe(true);
    expect(marksBoardDirty(hint('glob.deleted'))).toBe(true);
    expect(marksBoardDirty(hint('board.kb'))).toBe(true);
    expect(marksBoardDirty(hint('glob.deploys'))).toBe(false);
    expect(marksBoardDirty(hint('board.health'))).toBe(false);
  });

  it('tells a tap of every hint, even for a board nobody has open', () => {
    const hub = new HintHub();
    const seen: Hint[] = [];
    hub.tap((h) => seen.push(h));
    hub.publish({ kind: 'board.kb', boardId: 9 });
    expect(seen).toEqual([{ kind: 'board.kb', boardId: 9 }]);
  });
});
