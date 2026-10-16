import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, healthKey, notificationsKey, RequestError } from './api';
import type { GlobView } from './api';
import { putGlob } from './glob-list';

interface Hint {
  readonly kind:
    | 'glob.changed'
    | 'glob.deleted'
    | 'glob.artifacts'
    | 'glob.deploys'
    | 'glob.findings'
    | 'glob.decisions'
    | 'board.changed'
    | 'board.kb'
    | 'board.health'
    | 'board.notifications'
    | 'board.inbox';
  readonly globId?: string;
  readonly version?: number;
}

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'paused';

export const globsKey = (boardId: number) => ['globs', boardId] as const;

/** One glob in the glob view. */
export const globKey = (id: string) => ['glob', id] as const;
export const signedOffCountKey = (boardId: number) => ['signed-off-count', boardId] as const;

/** The board's deploy indicators and running environments; invalidated by `glob.deploys` hints. */
export const deploysKey = (boardId: number) => ['deploys', boardId] as const;

/** One glob's deploy history in the glob view. */
export const globDeploysKey = (globId: string) => ['glob-deploys', globId] as const;

/** One glob's ATF runs in the glob view; invalidated by `glob.deploys` hints and on reconnect. */
export const globTestsKey = (globId: string) => ['glob-tests', globId] as const;

/** One glob's review findings in the glob view; invalidated by `glob.findings` hints and on reconnect. */
export const findingsKey = (globId: string) => ['findings', globId] as const;

/** The board's inbox items; invalidated by `board.inbox` hints and on reconnect (and polled while one is being summarised). */
export const inboxKey = (boardId: number) => ['inbox', boardId] as const;

/** One glob's decisions in the glob view; invalidated by `glob.decisions` hints and on reconnect. */
export const globDecisionsKey = (globId: string) => ['glob-decisions', globId] as const;

/** A decision glob's proposed change and draft in the glob view; invalidated by that glob's hints. */
export const globDiffKey = (globId: string) => ['glob-diff', globId] as const;

/** One artifact's versions in the glob view; invalidated by `glob.artifacts` hints. */
export const artifactKey = (globId: string, kind: string, label: string) => ['artifact', globId, kind, label] as const;

/**
 * Everything the Knowledge page and the board's job statuses read: documents, agent-set files and the KB jobs.
 * Invalidated by `board.kb` (and `board.changed`) hints, on reconnect, and after the page's own writes.
 */
export const invalidateKnowledge = (client: QueryClient, boardId: number) => {
  for (const key of ['kb', 'knowledge-page', 'kb-doc', 'kb-agent-file', 'kb-jobs', 'sub-limit', 'dependency-rules', 'hotspots']) {
    void client.invalidateQueries({ queryKey: [key, boardId] });
  }
};

/**
 * Runs `work` once, `delayMs` after the last call: a burst of hints refetches the board's glob list (hundreds of KB) once, not once
 * per hint.
 */
export const trailing = (work: () => void, delayMs: number): { call: () => void; cancel: () => void } => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    call: () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        work();
      }, delayMs);
    },
    cancel,
  };
};

/** How long `board.kb` hints settle before the glob list is read again. */
export const KB_REFETCH_MS = 2_000;
/** After a reconnect each tab waits a random part of this before reloading the board, so a server restart isn't followed by every open tab reloading it at once. */
export const RECONNECT_SPREAD_MS = 4_000;

/** Delay before reopening a stream the browser closed for good: 1s, doubling to a 30s ceiling. */
export const reconnectDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, 30_000);

/** How long an open stream may stay silent before it is treated as dead. The server pings every 25 s. */
export const SILENCE_MS = 60_000;

interface StreamHandlers {
  readonly onHint: (hint: Hint) => void;
  readonly onReconnect: () => void;
  readonly onState: (state: LiveState) => void;
}

/**
 * Opens the board's event stream and keeps it open until the returned function is called.
 *
 * - The stream is closed while the tab is hidden, so background tabs don't hold one of the browser's few
 *   connections to the server (over HTTP/1.1, Chrome allows six per host and long-lived streams count against them).
 * - The browser retries a dropped connection itself, but closes the stream for good on a non-200 reply
 *   (e.g. while the server restarts), so a closed stream is reopened here with backoff.
 * - A stream can also stay open while nothing arrives (after a server restart behind a proxy), so it is closed and
 *   reopened when no `ready`, `hint` or `ping` has arrived for `SILENCE_MS`.
 * - `onReconnect` runs on each `ready` after the first, and on the first one when the page's data may be stale:
 *   the page loaded hidden, or the stream was closed (hidden or silent) since it last was ready.
 */
export const connectBoardStream = (boardId: number, handlers: StreamHandlers): (() => void) => {
  let source: EventSource | null = null;
  let connectedBefore = false;
  let stale = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let silence: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const stopSilence = () => {
    if (silence !== null) clearTimeout(silence);
    silence = null;
  };

  /** Restarts the silence clock; every sign of life from the server calls it. */
  const heard = () => {
    stopSilence();
    silence = setTimeout(() => {
      silence = null;
      source?.close();
      source = null;
      stale = true;
      handlers.onState('reconnecting');
      open();
    }, SILENCE_MS);
  };

  const open = () => {
    if (source !== null) return;
    const next = new EventSource(`/api/boards/${boardId}/events`);
    next.addEventListener('ready', () => {
      heard();
      handlers.onState('live');
      attempt = 0;
      if (connectedBefore || stale) handlers.onReconnect();
      connectedBefore = true;
      stale = false;
    });
    next.addEventListener('hint', (event: MessageEvent<string>) => {
      heard();
      handlers.onHint(JSON.parse(event.data) as Hint);
    });
    next.addEventListener('ping', heard);
    next.onerror = () => {
      handlers.onState('reconnecting');
      if (next.readyState !== EventSource.CLOSED || retry !== null) return;
      next.close();
      source = null;
      stopSilence();
      retry = setTimeout(() => {
        retry = null;
        open();
      }, reconnectDelay(attempt));
      attempt += 1;
    };
    source = next;
    heard();
  };

  const close = () => {
    if (retry !== null) clearTimeout(retry);
    retry = null;
    stopSilence();
    source?.close();
    source = null;
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      close();
      stale = true;
      handlers.onState('paused');
    } else {
      open();
    }
  };

  if (document.visibilityState === 'hidden') {
    stale = true;
    handlers.onState('paused');
  } else open();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    close();
  };
};

/** The board's event stream as a hook: `onHint` for each hint, `onReconnect` when hints may have been missed. */
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

  useEffect(
    () =>
      connectBoardStream(boardId, {
        onHint: (hint) => latest.current.onHint(hint),
        onReconnect: () => latest.current.onReconnect(),
        onState: setState,
      }),
    [boardId],
  );

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

  const replace = (glob: GlobView | null, id: string) => {
    const was = client.getQueryData<GlobView[]>(globsKey(boardId))?.find((g) => g.id === id);
    if (glob === null) client.setQueryData<GlobView[]>(globsKey(boardId), (list) => list?.filter((g) => g.id !== id));
    else putGlob(client, globsKey(boardId), glob, boardId);
    // The signed-off total changes when a glob is signed off, or leaves that list (started again, deleted).
    if (glob?.list === 'signed_off' || was?.list === 'signed_off') void client.invalidateQueries({ queryKey: signedOffCountKey(boardId) });
  };

  // One per board, so a burst of hints shares one refetch; pending timers end with the board or the page.
  const kbRefetch = useRef<ReturnType<typeof trailing> | null>(null);
  const reloads = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    const refetch = trailing(() => void client.invalidateQueries({ queryKey: globsKey(boardId) }), KB_REFETCH_MS);
    kbRefetch.current = refetch;
    return () => {
      refetch.cancel();
      kbRefetch.current = null;
      reloads.current.forEach(clearTimeout);
      reloads.current = [];
    };
  }, [client, boardId]);

  const onHint = (hint: Hint) => {
    if (hint.kind === 'board.changed') {
      void client.invalidateQueries({ queryKey: ['board', boardId] });
      return;
    }
    // The Knowledge page follows these itself; the board only needs them for decision globs, which the pipeline and mining
    // create and draft without a glob hint of their own (the board list has no KB data otherwise).
    if (hint.kind === 'board.kb') {
      kbRefetch.current?.call();
      void client.invalidateQueries({ queryKey: ['glob-diff'] });
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
      void client.invalidateQueries({ queryKey: globTestsKey(id) });
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
    void client.invalidateQueries({ queryKey: globDiffKey(id) });
    if (hint.kind === 'glob.artifacts') {
      // Artifacts don't bump the glob's version, so always refetch (the view carries their summaries).
      void client.invalidateQueries({ queryKey: ['artifact', id] });
      void client.invalidateQueries({ queryKey: ['plan', id] });
      void client.invalidateQueries({ queryKey: ['test-plan', id] });
    } else {
      const known = client.getQueryData<GlobView[]>(globsKey(boardId))?.find((g) => g.id === id);
      if (known !== undefined && hint.version !== undefined && known.version >= hint.version) return;
    }
    api
      .glob(id)
      .then((glob) => replace(glob, id))
      .catch((error: unknown) => {
        if (error instanceof RequestError && error.status === 404) replace(null, id);
        // Any other failure would leave a new glob off the board until a refresh: read the whole list instead.
        else void client.invalidateQueries({ queryKey: globsKey(boardId) });
      });
  };

  // Hints may have been missed while disconnected or hidden: reload the board (the glob list first, spread over a few seconds).
  const onReconnect = () => {
    reloads.current.push(
      setTimeout(() => {
        void client.invalidateQueries({ queryKey: globsKey(boardId) });
        void client.invalidateQueries({ queryKey: signedOffCountKey(boardId) });
      }, Math.random() * RECONNECT_SPREAD_MS),
    );
    // Deploys and readiness live beside the globs, so missed deploy hints need their own refresh.
    void client.invalidateQueries({ queryKey: deploysKey(boardId) });
    void client.invalidateQueries({ queryKey: ['glob-deploys'] });
    void client.invalidateQueries({ queryKey: ['glob-tests'] });
    void client.invalidateQueries({ queryKey: ['readiness', boardId] });
    void client.invalidateQueries({ queryKey: notificationsKey(boardId) });
    void client.invalidateQueries({ queryKey: inboxKey(boardId) });
    void client.invalidateQueries({ queryKey: ['findings'] });
    void client.invalidateQueries({ queryKey: ['glob-decisions'] });
    void client.invalidateQueries({ queryKey: ['glob-diff'] });
  };

  return useBoardEvents(boardId, { onHint, onReconnect });
};
