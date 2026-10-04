import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, RequestError } from './api';
import type { GlobView } from './api';

interface Hint {
  readonly kind: 'glob.changed' | 'glob.deleted' | 'board.changed';
  readonly globId?: string;
  readonly version?: number;
}

export const globsKey = (boardId: number) => ['globs', boardId] as const;

/**
 * Keeps the board's glob list live: each hint refetches only that glob, and a reconnect
 * reloads the whole board in case hints were missed.
 */
export const useLiveBoard = (boardId: number): 'connecting' | 'live' | 'reconnecting' => {
  const client = useQueryClient();
  const [state, setState] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');

  useEffect(() => {
    const source = new EventSource(`/api/boards/${boardId}/events`);
    let connectedBefore = false;

    const replace = (glob: GlobView | null, id: string) =>
      client.setQueryData<GlobView[]>(globsKey(boardId), (list = []) => {
        const rest = list.filter((g) => g.id !== id);
        return glob === null ? rest : [...rest, glob];
      });

    source.addEventListener('ready', () => {
      setState('live');
      if (connectedBefore) void client.invalidateQueries({ queryKey: globsKey(boardId) });
      connectedBefore = true;
    });
    source.addEventListener('hint', (event: MessageEvent<string>) => {
      const hint = JSON.parse(event.data) as Hint;
      if (hint.kind === 'board.changed') {
        void client.invalidateQueries({ queryKey: ['board', boardId] });
        return;
      }
      const id = hint.globId;
      if (id === undefined) return;
      const known = client.getQueryData<GlobView[]>(globsKey(boardId))?.find((g) => g.id === id);
      if (hint.kind === 'glob.deleted') {
        replace(null, id);
        return;
      }
      if (known !== undefined && hint.version !== undefined && known.version >= hint.version) return;
      api
        .glob(id)
        .then((glob) => replace(glob, id))
        .catch((error: unknown) => {
          if (error instanceof RequestError && error.status === 404) replace(null, id);
        });
      void client.invalidateQueries({ queryKey: ['glob', id] });
    });
    source.onerror = () => setState('reconnecting');
    return () => source.close();
  }, [boardId, client]);

  return state;
};
