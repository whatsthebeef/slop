import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import './index.css';
import { RequestError } from './lib/api';
import { BoardPage } from './pages/board';
import { KnowledgePage } from './pages/knowledge';
import { BoardsPage, HomePage, LoginPage } from './pages/home';
import { SettingsPage, SignedOffPage } from './pages/settings';
import { BoardShell } from './components/board-shell';
import { ToastProvider } from './toast';

const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof RequestError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

/** Sends anyone without a session to the sign-in page. */
const RequireSession = ({ children }: { children: ReactNode }) => {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        const error: unknown = event.query.state.error;
        if (error instanceof RequestError && error.status === 401) {
          // Already signing in: leave the page (and its returnTo) alone.
          if (location.pathname === '/login') return;
          // Keep where they were headed, so sign-in can return them there.
          const target = location.pathname + location.search;
          void navigate(location.pathname === '/' ? '/login' : `/login?returnTo=${encodeURIComponent(target)}`);
        }
      }),
    [navigate, location.pathname, location.search],
  );
  return children;
};

const root = document.getElementById('root');
if (root === null) throw new Error('No #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BrowserRouter>
          <RequireSession>
            <Routes>
              <Route path='/login' element={<LoginPage />} />
              <Route path='/' element={<HomePage />} />
              <Route path='/boards' element={<BoardsPage />} />
              <Route path='/boards/:boardId' element={<BoardShell />}>
                <Route index element={<BoardPage />} />
                <Route path='signed-off' element={<SignedOffPage />} />
                <Route path='settings' element={<SettingsPage />} />
                <Route path='knowledge' element={<KnowledgePage />} />
              </Route>
            </Routes>
          </RequireSession>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
