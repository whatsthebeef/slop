import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, RequestError } from './api';
import type { GlobView } from './api';

interface Hint {
  readonly kind: 'glob.changed' | 'glob.deleted' | 'glob.artifacts' | 'glob.deploys' | 'board.changed' | 'board.kb';
  readonly globId?: string;
  readonly version?: number;
}

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'paused';

export const globsKey = (boardId: number) => ['globs', boardId] as const;

/** The board's deploy indicators and running environments; invalidated by `glob.deploys` hints. */
export const deploysKey = (boardId: number) => ['deploys', boardId] as const;

/** One glob's deploy history in the glob view. */
export const globDeploysKey = (globId: string) => ['glob-deploys', globId] as const;

/** One artifact's versions in the glob view; invalidated by `glob.artifacts` hints. */
export const artifactKey = (globId: string, kind: string, label: string) => ['artifact', globId, kind, label] as const;

/**
 * Everything the Knowledge page reads: KB items, documents, agent-set files and draft targets.
 * Invalidated by `board.kb` (and `board.changed`) hints, on reconnect, and after the page's own writes.
 */
export const invalidateKnowledge = (client: QueryClient, boardId: number) => {
  for (const key of ['kb-proposals', 'kb', 'kb-doc', 'kb-agent-file', 'kb-target-text']) {
    void client.invalidateQueries({ queryKey: [key, boardId] });
  }
};

/**
 * The board's event stream: `onHint` for each hint, `onReconnect` each time it is ready again after
 * the first time (hints may have been missed meanwhile). The stream is closed while the tab is
 * hidden, so background tabs don't hold one of the browser's few connections to the server
 * (over HTTP/1.1, Chrome allows six per host and long-lived streams count against them).
 */
const useBoardEvents = (
  boardId: number,
  handlers: { onHint: (hint: Hint) => void; onReconnect: () => void },
): LiveState => {
  const [state, setState] = useState<LiveState>('connecting');
  // The latest handlers, without reopening the stream when they change.
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    let source: EventSource | null = null;
    let connectedBefore = false;

    const open = () => {
      if (source !== null) return;
      const next = new EventSource(`/api/boards/${boardId}/events`);
      next.addEventListener('ready', () => {
        setState('live');
        if (connectedBefore) latest.current.onReconnect();
        connectedBefore = true;
      });
      next.addEventListener('hint', (event: MessageEvent<string>) => latest.current.onHint(JSON.parse(event.data) as Hint));
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
  }, [boardId]);

  return state;
};

/**
 * Keeps the Knowledge page live: KB data lives beside the globs, so `board.kb` hints, `board.changed`
 * (an agent-set version bump) and every reconnect refetch it.
 */
export const useLiveKnowledge = (boardId: number): LiveState => {
  const client = useQueryClient();
  return useBoardEvents(boardId, {
    onHint: (hint) => {
      if (hint.kind === 'board.changed') void client.invalidateQueries({ queryKey: ['board', boardId] });
      if (hint.kind === 'board.kb' || hint.kind === 'board.changed') invalidateKnowledge(client, boardId);
    },
    onReconnect: () => {
      void client.invalidateQueries({ queryKey: ['board', boardId] });
      invalidateKnowledge(client, boardId);
    },
  });
};

/**
 * Keeps the board's glob list live: each hint refetches only that glob, and every reconnect
 * reloads the whole board in case hints were missed.
 */
export const useLiveBoard = (boardId: number): LiveState => {
  const client = useQueryClient();

  const replace = (glob: GlobView | null, id: string) =>
    client.setQueryData<GlobView[]>(globsKey(boardId), (list = []) => {
      const rest = list.filter((g) => g.id !== id);
      return glob === null ? rest : [...rest, glob];
    });

  const onHint = (hint: Hint) => {
    if (hint.kind === 'board.changed') {
      void client.invalidateQueries({ queryKey: ['board', boardId] });
      return;
    }
    // The board shows no KB data; the Knowledge page follows those hints itself.
    if (hint.kind === 'board.kb') return;
    const id = hint.globId;
    if (id === undefined) return;
    if (hint.kind === 'glob.deploys') {
      // Deploys live beside the glob, not on it: refresh the board's indicators and the glob's history.
      void client.invalidateQueries({ queryKey: deploysKey(boardId) });
      void client.invalidateQueries({ queryKey: globDeploysKey(id) });
      return;
    }
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

  // Hints may have been missed while disconnected or hidden: reload the board.
  const onReconnect = () => {
    void client.invalidateQueries({ queryKey: globsKey(boardId) });
    // Deploys and readiness live beside the globs, so missed deploy hints need their own refresh.
    void client.invalidateQueries({ queryKey: deploysKey(boardId) });
    void client.invalidateQueries({ queryKey: ['glob-deploys'] });
    void client.invalidateQueries({ queryKey: ['readiness', boardId] });
  };

  return useBoardEvents(boardId, { onHint, onReconnect });
};
