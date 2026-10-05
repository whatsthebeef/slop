import { Outlet, useParams } from 'react-router';
import { StatusBar } from '@/components/status-bar';

/** Every board page sits under the app's status bar; the page fills the rest of the window. */
export const BoardShell = () => {
  const boardId = Number(useParams().boardId);
  return (
    <div className="flex h-dvh flex-col">
      <StatusBar current={Number.isInteger(boardId) ? boardId : undefined} />
      <div className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
};
