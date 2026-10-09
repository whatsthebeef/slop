import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, healthKey, notificationsKey, RequestError } from './api';
import type { GlobView } from './api';
import { withGlob } from './glob-list';

interface Hint {
  readonly kind:
    | 'glob.changed'
    | 'glob.deleted'
    | 'glob.artifacts'
    | 'glob.deploys'
    | 'glob.findings'
    | 'glob.decisions'
    | 'glob.reviews'
    | 'board.changed'
    | 'board.kb'
    | 'board.tests'
    | 'board.health'
    | 'board.notifications'
    | 'board.inbox';
  readonly globId?: string;
  readonly version?: number;
}

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'paused';

export const globsKey = (boardId: number) => ['globs', boardId] as const;

/** The board's deploy indicators and running environments; invalidated by `glob.deploys` hints. */
export const deploysKey = (boardId: number) => ['deploys', boardId] as const;

/** One glob's deploy history in the glob view. */
export const globDeploysKey = (globId: string) => ['glob-deploys', globId] as const;

/** The release and integration environments in the glob view; invalidated by `glob.deploys` hints and on reconnect. */
export const globEnvironmentsKey = (globId: string) => ['glob-environments', globId] as const;

/** One glob's ATF runs in the glob view; invalidated by `glob.deploys` and `board.tests` hints and on reconnect. */
export const globTestsKey = (globId: string) => ['glob-tests', globId] as const;

/** The cards' CodeRabbit badges; invalidated by `glob.reviews` hints and on reconnect. */
export const codeReviewsKey = (boardId: number) => ['code-reviews', boardId] as const;

/** One glob's stored CodeRabbit review in the glob view; invalidated by `glob.reviews` hints and on reconnect. */
export const globCodeReviewKey = (globId: string) => ['glob-code-review', globId] as const;

/** One glob's review findings in the glob view; invalidated by `glob.findings` hints and on reconnect. */
export const findingsKey = (globId: string) => ['findings', globId] as const;

/** The board's inbox items; invalidated by `board.inbox` hints and on reconnect (and polled while one is being summarised). */
export const inboxKey = (boardId: number) => ['inbox', boardId] as const;

/** One glob's decisions in the glob view; invalidated by `glob.decisions` hints and on reconnect. */
export const globDecisionsKey = (globId: string) => ['glob-decisions', globId] as const;

/** One artifact's versions in the glob view; invalidated by `glob.artifacts` hints. */
export const artifactKey = (globId: string, kind: string, label: string) => ['artifact', globId, kind, label] as const;

/**
 * Everything the Knowledge page reads: KB items, documents, agent-set files and draft targets.
 * Invalidated by `board.kb` (and `board.changed`) hints, on reconnect, and after the page's own writes.
 */
export const invalidateKnowledge = (client: QueryClient, boardId: number) => {
  for (const key of ['kb-proposals', 'kb', 'kb-doc', 'kb-agent-file', 'kb-target-text', 'kb-jobs', 'sub-limit']) {
    void client.invalidateQueries({ queryKey: [key, boardId] });
  }
};

/** Delay before reopening a stream the browser closed for good: 1s, doubling to a 30s ceiling. */
export const reconnectDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, 30_000);

/**
 * The board's event stream: `onHint` for each hint, `onReconnect` each time it is ready again after
 * the first time (hints may have been missed meanwhile). The stream is closed while the tab is
 * hidden, so background tabs don't hold one of the browser's few connections to the server
 * (over HTTP/1.1, Chrome allows six per host and long-lived streams count against them).
 * The browser retries a dropped connection itself, but closes the stream for good on a non-200 reply
 * (e.g. while the server restarts), so a closed stream is reopened here with backoff.
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
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const open = () => {
      if (source !== null) return;
      const next = new EventSource(`/api/boards/${boardId}/events`);
      next.addEventListener('ready', () => {
        setState('live');
        attempt = 0;
        if (connectedBefore) latest.current.onReconnect();
        connectedBefore = true;
      });
      next.addEventListener('hint', (event: MessageEvent<string>) => latest.current.onHint(JSON.parse(event.data) as Hint));
      next.onerror = () => {
        setState('reconnecting');
        if (next.readyState !== EventSource.CLOSED || retry !== null) return;
        next.close();
        source = null;
        retry = setTimeout(() => {
          retry = null;
          open();
        }, reconnectDelay(attempt));
        attempt += 1;
      };
      source = next;
    };

    const close = () => {
      if (retry !== null) clearTimeout(retry);
      retry = null;
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
      if (hint.kind === 'board.notifications') void client.invalidateQueries({ queryKey: notificationsKey(boardId) });
      if (hint.kind === 'board.kb' || hint.kind === 'board.changed') invalidateKnowledge(client, boardId);
    },
    onReconnect: () => {
      void client.invalidateQueries({ queryKey: ['board', boardId] });
      void client.invalidateQueries({ queryKey: notificationsKey(boardId) });
      invalidateKnowledge(client, boardId);
    },
  });
};

/** Keeps the Inbox page live: `board.inbox` hints (an item added, summarised, attached, kept or discarded) and every reconnect refetch it. */
export const useLiveInbox = (boardId: number): LiveState => {
  const client = useQueryClient();
  return useBoardEvents(boardId, {
    onHint: (hint) => {
      if (hint.kind === 'board.inbox') void client.invalidateQueries({ queryKey: inboxKey(boardId) });
      if (hint.kind === 'board.notifications') void client.invalidateQueries({ queryKey: notificationsKey(boardId) });
      // An attach puts an attachment on globs; the page lists their titles from the board's glob list.
      if (hint.kind === 'glob.changed' || hint.kind === 'glob.deleted') void client.invalidateQueries({ queryKey: globsKey(boardId) });
    },
    onReconnect: () => {
      void client.invalidateQueries({ queryKey: inboxKey(boardId) });
      void client.invalidateQueries({ queryKey: globsKey(boardId) });
      void client.invalidateQueries({ queryKey: notificationsKey(boardId) });
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
    client.setQueryData<GlobView[]>(globsKey(boardId), (list) =>
      glob === null ? list?.filter((g) => g.id !== id) : withGlob(list, glob, boardId),
    );

  const onHint = (hint: Hint) => {
    if (hint.kind === 'board.changed') {
      void client.invalidateQueries({ queryKey: ['board', boardId] });
      return;
    }
    // The board shows no KB data; the Knowledge page follows those hints itself.
    if (hint.kind === 'board.kb') return;
    if (hint.kind === 'board.tests') {
      // An environment's ATF run (or the check that placed globs at its commit): it shows on every glob held there.
      void client.invalidateQueries({ queryKey: deploysKey(boardId) });
      void client.invalidateQueries({ queryKey: ['glob-environments'] });
      void client.invalidateQueries({ queryKey: ['glob-tests'] });
      return;
    }
    if (hint.kind === 'board.notifications') {
      void client.invalidateQueries({ queryKey: notificationsKey(boardId) });
      return;
    }
    if (hint.kind === 'board.inbox') {
      // The Inbox tab's count shows on every board page.
      void client.invalidateQueries({ queryKey: inboxKey(boardId) });
      return;
    }
    if (hint.kind === 'board.health') {
      void client.invalidateQueries({ queryKey: healthKey });
      // Integration problems are global notifications, which raise no board hint of their own.
      void client.invalidateQueries({ queryKey: notificationsKey(boardId) });
      return;
    }
    const id = hint.globId;
    if (id === undefined) return;
    if (hint.kind === 'glob.deploys') {
      // Deploys live beside the glob, not on it: refresh the board's indicators and the glob's history.
      void client.invalidateQueries({ queryKey: deploysKey(boardId) });
      void client.invalidateQueries({ queryKey: globDeploysKey(id) });
      void client.invalidateQueries({ queryKey: globEnvironmentsKey(id) });
      void client.invalidateQueries({ queryKey: globTestsKey(id) });
      return;
    }
    if (hint.kind === 'glob.reviews') {
      // CodeRabbit's stored review lives beside the glob: refresh the cards' badges and the glob view.
      void client.invalidateQueries({ queryKey: codeReviewsKey(boardId) });
      void client.invalidateQueries({ queryKey: globCodeReviewKey(id) });
      return;
    }
    if (hint.kind === 'glob.findings') {
      // Findings live beside the glob too; only the glob view reads them.
      void client.invalidateQueries({ queryKey: findingsKey(id) });
      return;
    }
    if (hint.kind === 'glob.decisions') {
      // Decisions live beside the glob too; only the glob view reads them.
      void client.invalidateQueries({ queryKey: globDecisionsKey(id) });
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
    void client.invalidateQueries({ queryKey: ['glob-environments'] });
    void client.invalidateQueries({ queryKey: ['glob-tests'] });
    void client.invalidateQueries({ queryKey: ['readiness', boardId] });
    void client.invalidateQueries({ queryKey: notificationsKey(boardId) });
    void client.invalidateQueries({ queryKey: inboxKey(boardId) });
    void client.invalidateQueries({ queryKey: ['findings'] });
    void client.invalidateQueries({ queryKey: ['glob-decisions'] });
    void client.invalidateQueries({ queryKey: codeReviewsKey(boardId) });
    void client.invalidateQueries({ queryKey: ['glob-code-review'] });
  };

  return useBoardEvents(boardId, { onHint, onReconnect });
};
