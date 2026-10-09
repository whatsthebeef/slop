import { Link, Outlet, useLocation, useParams } from 'react-router';
import { NotificationBar } from '@/components/notification-bar';
import { SearchBox } from '@/components/search-box';
import { StatusBar } from '@/components/status-bar';
import { activeTab, BOARD_TABS } from '@/lib/notification-bar';
import { cn } from '@/lib/utils';

/** Board, Signed off, Knowledge and Settings as tabs; the active one sits on the line below. */
const BoardTabs = ({ boardId }: { boardId: number }) => {
  const current = activeTab(useLocation().pathname, boardId);
  return (
    <header className='flex flex-wrap items-end gap-x-6 px-5 pt-4 text-sm'>
      <nav className='flex gap-6' aria-label='Board sections'>
        {BOARD_TABS.map(({ tab, label, path }) => (
          <Link
            key={tab}
            to={`/boards/${String(boardId)}${path}`}
            aria-current={current === tab ? 'page' : undefined}
            className={cn('-mb-px border-b-2 pb-1.5', current === tab ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {label}
          </Link>
        ))}
      </nav>
      <div className='ml-auto pb-1'>
        <SearchBox boardId={boardId} />
      </div>
    </header>
  );
};

/** Every board page sits under the app's status bar; the page fills the rest of the window. */
export const BoardShell = () => {
  const boardId = Number(useParams().boardId);
  const isBoard = Number.isInteger(boardId);
  return (
    <div className='flex h-dvh flex-col'>
      <StatusBar current={isBoard ? boardId : undefined} />
      {isBoard && <NotificationBar boardId={boardId} />}
      {isBoard && <BoardTabs boardId={boardId} />}
      {isBoard && <hr className='mx-5 border-edge' />}
      <div className='min-h-0 flex-1 overflow-auto'>
        <Outlet />
      </div>
    </div>
  );
};
