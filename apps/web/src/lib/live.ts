import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, RequestError } from './api';
import type { GlobView } from './api';

interface Hint {
  readonly kind: 'glob.changed' | 'glob.deleted' | 'glob.artifacts' | 'board.changed';
  readonly globId?: string;
  readonly version?: number;
}

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'paused';

export const globsKey = (boardId: number) => ['globs', boardId] as const;

/** One artifact's versions in the glob view; invalidated by `glob.artifacts` hints. */
export const artifactKey = (globId: string, kind: string, label: string) => ['artifact', globId, kind, label] as const;

/**
 * Keeps the board's glob list live: each hint refetches only that glob, and every reconnect
 * reloads the whole board in case hints were missed. The stream is closed while the tab is
 * hidden, so background tabs don't hold one of the browser's few connections to the server
 * (over HTTP/1.1, Chrome allows six per host and long-lived streams count against them).
 */
export const useLiveBoard = (boardId: number): LiveState => {
  const client = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');

  useEffect(() => {
    let source: EventSource | null = null;
    let connectedBefore = false;

    const replace = (glob: GlobView | null, id: string) =>
      client.setQueryData<GlobView[]>(globsKey(boardId), (list = []) => {
        const rest = list.filter((g) => g.id !== id);
        return glob === null ? rest : [...rest, glob];
      });

    const onHint = (event: MessageEvent<string>) => {
      const hint = JSON.parse(event.data) as Hint;
      if (hint.kind === 'board.changed') {
        void client.invalidateQueries({ queryKey: ['board', boardId] });
        return;
      }
      const id = hint.globId;
      if (id === undefined) return;
      if (hint.kind === 'glob.deleted') {
        replace(null, id);
        return;
      }
      if (hint.kind === 'glob.artifacts') {
        // Artifacts don't bump the glob's version, so always refetch (the view carries their summaries).
        void client.invalidateQueries({ queryKey: ['artifact', id] });
        void client.invalidateQueries({ queryKey: ['plan', id] });
      } else {
        const known = client.getQueryData<GlobView[]>(globsKey(boardId))?.find((g) => g.id === id);
        if (known !== undefined && hint.version !== undefined && known.version >= hint.version) return;
      }
      api
        .glob(id)
        .then((glob) => replace(glob, id))
        .catch((error: unknown) => {
          if (error instanceof RequestError && error.status === 404) replace(null, id);
        });
    };

    const open = () => {
      if (source !== null) return;
      const next = new EventSource(`/api/boards/${boardId}/events`);
      next.addEventListener('ready', () => {
        setState('live');
        // Hints may have been missed while disconnected or hidden: reload the board.
        if (connectedBefore) void client.invalidateQueries({ queryKey: globsKey(boardId) });
        connectedBefore = true;
      });
      next.addEventListener('hint', onHint);
      next.onerror = () => setState('reconnecting');
      source = next;
    };

    const close = () => {
      source?.close();
      source = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        close();
        setState('paused');
      } else {
        open();
      }
    };

    if (document.visibilityState === 'hidden') setState('paused');
    else open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    };
  }, [boardId, client]);

  return state;
};
