import { Outlet, useParams } from 'react-router';
import { IntegrationBanner } from '@/components/integration-banner';
import { NotificationBar } from '@/components/notification-bar';
import { StatusBar } from '@/components/status-bar';

/** Every board page sits under the app's status bar; the page fills the rest of the window. */
export const BoardShell = () => {
  const boardId = Number(useParams().boardId);
  return (
    <div className="flex h-dvh flex-col">
      <StatusBar current={Number.isInteger(boardId) ? boardId : undefined} />
      <IntegrationBanner />
      {Number.isInteger(boardId) && <NotificationBar boardId={boardId} />}
      <div className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
};
