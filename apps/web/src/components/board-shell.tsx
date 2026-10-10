import { MessageCircle } from 'lucide-react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useParams } from 'react-router';
import { ChatDock } from '@/components/chat-dock';
import { NotificationBar } from '@/components/notification-bar';
import { AppSettings, BoardBar, useOpenBoard } from '@/components/board-bar';
import { api } from '@/lib/api';
import { hideSignedOff, isChatShortcut, WIDE_QUERY } from '@/lib/chat';
import { newCount } from '@/lib/inbox';
import { BOARD_PAGE, PageContextProvider } from '@/lib/page-context';
import type { PageContext } from '@/lib/page-context';
import { inboxKey } from '@/lib/live';
import { activeTab, BOARD_TABS, pollInterval } from '@/lib/notification-bar';
import { cn } from '@/lib/utils';

/** What the shell gives its pages: the slot for a page's own tab-row icon (the board's ＋ New glob), and whether the docked chat has pushed Signed Off aside. */
export interface BoardShellContext {
  headerActions: HTMLElement | null;
  hideSignedOff: boolean;
}

/** Board, Inbox, Signed off, Knowledge and Settings as tabs on a thin line; the active one is underlined on it. The ＋, chat and settings icons sit at its right. */
const BoardTabs = ({
  boardId,
  onActions,
  onChat,
  chatOpen,
}: {
  boardId: number;
  onActions: (el: HTMLElement | null) => void;
  onChat: () => void;
  chatOpen: boolean;
}) => {
  const current = activeTab(useLocation().pathname, boardId);
  // The Inbox tab counts items waiting for a person; hints refresh it on the pages that listen, and a slow poll covers the rest.
  const inbox = useQuery({ queryKey: inboxKey(boardId), queryFn: () => api.inbox(boardId), refetchInterval: pollInterval(false) });
  const waiting = newCount(inbox.data ?? []);
  return (
    <header className='mx-5 mt-1.5 flex flex-wrap items-end gap-x-6 border-b border-edge/50 text-sm'>
      <nav className='flex gap-6' aria-label='Board sections'>
        {BOARD_TABS.map(({ tab, label, path }) => (
          <Link
            key={tab}
            to={`/boards/${String(boardId)}${path}`}
            aria-current={current === tab ? 'page' : undefined}
            className={cn('-mb-px border-b-2 pb-1.5', current === tab ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {label}
            {tab === 'inbox' && waiting > 0 && <span className='ml-1.5 rounded-full bg-muted px-1.5 text-xs text-muted-foreground'>{waiting}</span>}
          </Link>
        ))}
      </nav>
      <div className='ml-auto flex items-center gap-1 pb-1.5'>
        <div ref={onActions} className='flex items-center' data-testid='header-actions' />
        <button
          type='button'
          className='rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground'
          aria-label='Ask the board chat'
          aria-pressed={chatOpen}
          title='Ask the board chat (/ or ⌘K)'
          data-testid='chat-toggle'
          onClick={onChat}
        >
          <MessageCircle className='h-4 w-4' aria-hidden />
        </button>
        <span className='mx-1 h-4 w-px bg-edge/50' aria-hidden />
        <AppSettings />
      </div>
    </header>
  );
};

/** True while the window matches the query. */
const useMedia = (query: string): boolean => {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
};

/**
 * Every board page sits under the app's board bar, the notification banner and the tab row; opening a board records it. The chat is docked
 * beside the routed page here, not inside it, so its conversation survives moving between pages.
 */
export const BoardShell = () => {
  const boardId = Number(useParams().boardId);
  const isBoard = Number.isInteger(boardId);
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null);
  // The shell stays mounted across the board's tabs, so this records each open once.
  useOpenBoard(isBoard ? boardId : undefined);
  const [chatOpen, setChatOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  // The conversation stays open across pages and while the panel is closed; the pages say where the person is.
  const [chatId, setChatId] = useState<number | null>(null);
  const [page, setPage] = useState<PageContext>(BOARD_PAGE);
  const wide = useMedia(WIDE_QUERY);
  const openChat = () => {
    setChatOpen(true);
    setFocusToken((n) => n + 1);
  };
  const closeChat = () => {
    setChatOpen(false);
    setFullScreen(false);
  };
  // The tab row's chat icon opens a closed panel and closes an open one; the shortcuts below only open it.
  const toggleChat = () => {
    if (chatOpen) closeChat();
    else openChat();
  };
  useEffect(() => {
    if (!isBoard) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isChatShortcut(e)) return;
      e.preventDefault();
      openChat();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isBoard]);
  const showChat = isBoard && chatOpen;
  // The panel stays mounted while it steps out (the dock says when it is gone), so Signed Off stays hidden until then.
  const [docked, setDocked] = useState(false);
  useLayoutEffect(() => {
    if (showChat) setDocked(true);
  }, [showChat]);
  const mounted = showChat || docked;
  return (
    <PageContextProvider page={page} setPage={setPage}>
    <div className='flex h-dvh flex-col'>
      <BoardBar current={isBoard ? boardId : undefined} />
      {isBoard && <NotificationBar boardId={boardId} />}
      {isBoard && <BoardTabs boardId={boardId} onActions={setHeaderActions} onChat={toggleChat} chatOpen={showChat} />}
      <div className='flex min-h-0 flex-1'>
        <div className='min-h-0 min-w-0 flex-1 overflow-auto' inert={showChat && fullScreen} data-testid='main-area'>
          <Outlet context={{ headerActions, hideSignedOff: hideSignedOff(mounted, wide) } satisfies BoardShellContext} />
        </div>
        {isBoard && mounted && (
          <ChatDock
            open={showChat}
            onExited={() => setDocked(false)}
            wide={wide}
            boardId={boardId}
            fullScreen={fullScreen}
            focusToken={focusToken}
            chatId={chatId}
            onChatChange={setChatId}
            onClose={closeChat}
            onFullScreenChange={setFullScreen}
          />
        )}
      </div>
    </div>
    </PageContextProvider>
  );
};
