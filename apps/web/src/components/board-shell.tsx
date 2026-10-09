import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useParams } from 'react-router';
import { ChatPanel } from '@/components/chat-panel';
import { NotificationBar } from '@/components/notification-bar';
import { SearchBox } from '@/components/search-box';
import { BoardBar, useOpenBoard } from '@/components/board-bar';
import { api } from '@/lib/api';
import { askRequest } from '@/lib/chat';
import type { ChatRequest } from '@/lib/chat';
import { newCount } from '@/lib/inbox';
import { inboxKey } from '@/lib/live';
import { activeTab, BOARD_TABS, pollInterval } from '@/lib/notification-bar';
import { cn } from '@/lib/utils';

/** What the shell gives its pages: the slot beside the search box, for a page's own actions (the board's New Glob). */
export interface BoardShellContext {
  headerActions: HTMLElement | null;
}

/** Board, Inbox, Signed off, Knowledge and Settings as tabs on a thin line; the active one is underlined on it. */
const BoardTabs = ({ boardId, onActions }: { boardId: number; onActions: (el: HTMLElement | null) => void }) => {
  const current = activeTab(useLocation().pathname, boardId);
  // The Inbox tab counts items waiting for a person; hints refresh it on the pages that listen, and a slow poll covers the rest.
  const inbox = useQuery({ queryKey: inboxKey(boardId), queryFn: () => api.inbox(boardId), refetchInterval: pollInterval(false) });
  const waiting = newCount(inbox.data ?? []);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatRequest, setChatRequest] = useState<ChatRequest | null>(null);
  const requests = useRef(0);
  const askChat = (text: string, history: boolean) => {
    const next = askRequest(text, history, ++requests.current);
    if (next === null) return;
    setChatRequest(next);
    setChatOpen(true);
  };
  return (
    <header className='mx-5 mt-4 flex flex-wrap items-end gap-x-6 border-b border-edge/50 text-sm'>
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
      <div className='ml-auto flex items-center gap-2 pb-1.5'>
        <SearchBox boardId={boardId} onAsk={askChat} />
        <ChatPanel boardId={boardId} open={chatOpen} onOpenChange={setChatOpen} request={chatRequest} />
        <div ref={onActions} data-testid='header-actions' />
      </div>
    </header>
  );
};

/** Every board page sits under the app's board bar; the page fills the rest of the window. Opening a board records it. */
export const BoardShell = () => {
  const boardId = Number(useParams().boardId);
  const isBoard = Number.isInteger(boardId);
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null);
  // The shell stays mounted across the board's tabs, so this records each open once.
  const opened = useOpenBoard(isBoard ? boardId : undefined);
  return (
    <div className='flex h-dvh flex-col'>
      <BoardBar current={isBoard ? boardId : undefined} opened={opened} />
      {isBoard && <NotificationBar boardId={boardId} />}
      {isBoard && <BoardTabs boardId={boardId} onActions={setHeaderActions} />}
      <div className='min-h-0 flex-1 overflow-auto'>
        <Outlet context={{ headerActions } satisfies BoardShellContext} />
      </div>
    </div>
  );
};
