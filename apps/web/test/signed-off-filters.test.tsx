// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
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
            <Route path='globs/:globId' element={<p data-testid='glob-page'>glob page</p>} />
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
    expect(screen.getByTestId('filter-fix')).toBeTruthy();
    expect(screen.getByTestId('filter-id')).toBeTruthy();
    expect(screen.getByTestId('filter-human').getAttribute('aria-pressed')).toBe('false');
  });

  it('filters by fix and by ID or name', async () => {
    renderPage('/boards/1/signed-off?fix=1');
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
    await userEvent.setup().click(screen.getByTestId('filter-mode-same'));
    expect(await screen.findByTestId('no-match')).toBeTruthy();
  });
});

describe('Signed Off view cards', () => {
  it('shows a read-only GlobCard per glob in a grid', async () => {
    renderPage('/boards/1/signed-off');
    const grid = await screen.findByTestId('signed-off-grid');
    expect(within(grid).getByTestId('card-s1f1')).toBeTruthy();
    expect(within(grid).getByTestId('card-s1b2')).toBeTruthy();
    expect(within(screen.getByTestId('signed-off-s1f1')).getByTestId('card-s1f1')).toBeTruthy();
    expect(screen.queryByTestId('card-actions')).toBeNull();
    expect(screen.queryByRole('button', { name: /pick up|start|split/i })).toBeNull();
  });

  it('opens the glob page on a card click', async () => {
    renderPage('/boards/1/signed-off');
    await userEvent.setup().click(await screen.findByTestId('card-s1f1'));
    expect(await screen.findByTestId('glob-page')).toBeTruthy();
  });

  it('the group tag sets the group filter', async () => {
    api.signedOff.mockResolvedValue({
      next: null,
      globs: [view({ id: 's1f1', title: 'A', status: 'signed_off', group: 'alpha' }), view({ id: 's1f2', title: 'B', status: 'signed_off', group: 'beta' })],
    });
    renderPage('/boards/1/signed-off');
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId('card-s1f1')).getByTestId('group-chip'));
    expect(await screen.findByTestId('signed-off-s1f1')).toBeTruthy();
    expect(screen.queryByTestId('signed-off-s1f2')).toBeNull();
  });

  it('Load more pages in more cards and the filter applies to them', async () => {
    api.signedOff
      .mockResolvedValueOnce({ next: 'c2', globs: [view({ id: 's1f1', title: 'One', category: 'feature', status: 'signed_off' })] })
      .mockResolvedValueOnce({ next: null, globs: [view({ id: 's1b2', title: 'Two', category: 'bug', status: 'signed_off' })] });
    renderPage('/boards/1/signed-off?fix=1');
    expect(await screen.findByTestId('no-match')).toBeTruthy();
    await userEvent.setup().click(screen.getByText('Load more'));
    expect(await screen.findByTestId('card-s1b2')).toBeTruthy();
    expect(screen.queryByTestId('card-s1f1')).toBeNull();
  });

  it('offers no Approve or Re-open on label chips, and dates only signed-off cards', async () => {
    api.signedOff.mockResolvedValue({
      next: null,
      globs: [
        view({ id: 's1f1', title: 'Done feature', status: 'signed_off', signedOffAt: '2026-10-01T00:00:00.000Z' }),
        view({ id: 's1b2', title: 'Re-opened bug', category: 'bug', status: 'reviewing', labels: { CR: 'required' } }),
      ],
    });
    renderPage('/boards/1/signed-off');
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId('card-s1b2')).getByLabelText('Sign-off labels'));
    expect(await screen.findByText('Open review')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(approve|re-open)$/i })).toBeNull();
    expect(within(screen.getByTestId('card-s1f1')).getByTestId('card-status').getAttribute('data-kind')).toBe('signed-off');
    expect(within(screen.getByTestId('card-s1f1')).queryByTestId('card-signed-off')).toBeNull();
    expect(within(screen.getByTestId('card-s1b2')).getByTestId('card-status').getAttribute('data-kind')).not.toBe('signed-off');
  });
});
