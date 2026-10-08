import type { Hint, Notifier } from '@slop/core';

type Listener = (hint: Hint) => void;

/** In-process notifier: slop runs as a single instance, so hints fan out from memory to SSE streams. */
export class HintHub implements Notifier {
  private readonly listeners = new Map<number, Set<Listener>>();

  publish(hint: Hint): void {
    for (const listener of this.listeners.get(hint.boardId) ?? []) listener(hint);
  }

  /** A hint for every open board, for things that aren't a board's own (an integration's health). */
  broadcast(kind: 'board.health'): void {
    for (const boardId of this.listeners.keys()) this.publish({ kind, boardId });
  }

  subscribe(boardId: number, listener: Listener): () => void {
    const set = this.listeners.get(boardId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(boardId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(boardId);
    };
  }
}
