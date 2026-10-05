import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router';
import './index.css';
import { RequestError } from './lib/api';
import { BoardPage } from './pages/board';
import { KnowledgePage } from './pages/knowledge';
import { HomePage, LoginPage } from './pages/home';
import { SettingsPage, SignedOffPage } from './pages/settings';
import { ThemeToggle } from './components/theme-toggle';
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
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        const error: unknown = event.query.state.error;
        if (error instanceof RequestError && error.status === 401) void navigate('/login');
      }),
    [navigate],
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
              <Route path='/boards/:boardId' element={<BoardPage />} />
              <Route path='/boards/:boardId/signed-off' element={<SignedOffPage />} />
              <Route path='/boards/:boardId/settings' element={<SettingsPage />} />
              <Route path='/boards/:boardId/knowledge' element={<KnowledgePage />} />
            </Routes>
          </RequireSession>
        </BrowserRouter>
        <ThemeToggle />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
