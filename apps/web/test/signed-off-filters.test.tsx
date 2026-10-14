// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { SignedOffPage } from '../src/pages/settings';
import { glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView>): GlobView => ({ ...glob(), boardId: 1, ...patch }) as GlobView;

const api = vi.hoisted(() => ({ signedOff: vi.fn(), me: vi.fn(), board: vi.fn() }));
vi.mock('../src/lib/api', async (original) => ({ ...(await original<typeof import('../src/lib/api')>()), api: { ...api } }));

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  api.me.mockResolvedValue({ email: 'a@b.c' });
  api.board.mockResolvedValue({ role: 'admin' });
  api.signedOff.mockResolvedValue({
    next: null,
    globs: [
      view({ id: 's1f1', title: 'Done feature', category: 'feature', status: 'signed_off' }),
      view({ id: 's1b2', title: 'Re-opened bug', category: 'bug', status: 'reviewing', labels: { CR: 'required' } }),
    ],
  });
});

const renderPage = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path='/boards/:boardId' element={<Outlet context={{ headerActions: null }} />}>
            <Route path='signed-off' element={<SignedOffPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('Signed Off view filters', () => {
  it('renders the shared filter pane with the board filters and the Only human toggle', async () => {
    renderPage('/boards/1/signed-off');
    expect(await screen.findByTestId('signed-off-s1f1')).toBeTruthy();
    expect(screen.getByTestId('filter-pane')).toBeTruthy();
    expect(screen.getByTestId('filter-category-bug')).toBeTruthy();
    expect(screen.getByTestId('filter-id')).toBeTruthy();
    expect(screen.getByTestId('filter-human').getAttribute('aria-pressed')).toBe('false');
  });

  it('filters by category and by ID or name', async () => {
    renderPage('/boards/1/signed-off?category=bug');
    expect(await screen.findByTestId('signed-off-s1b2')).toBeTruthy();
    expect(screen.queryByTestId('signed-off-s1f1')).toBeNull();
    await userEvent.setup().click(screen.getByTestId('filter-clear'));
    expect(await screen.findByTestId('signed-off-s1f1')).toBeTruthy();
    await userEvent.setup().type(screen.getByTestId('filter-id'), 'done');
    expect(screen.queryByTestId('signed-off-s1b2')).toBeNull();
    expect(screen.getByTestId('signed-off-s1f1')).toBeTruthy();
  });

  it('Only human keeps just the globs that need a person, and says so when none do', async () => {
    renderPage('/boards/1/signed-off?human=1');
    expect(await screen.findByTestId('signed-off-s1b2')).toBeTruthy();
    expect(screen.queryByTestId('signed-off-s1f1')).toBeNull();
    expect(screen.getByTestId('filter-human').getAttribute('aria-pressed')).toBe('true');
    await userEvent.setup().click(screen.getByTestId('filter-category-bug'));
    expect(await screen.findByTestId('no-match')).toBeTruthy();
  });
});
