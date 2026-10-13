// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Action } from '@slop/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobDetail } from '../src/components/glob-dialog';
import type { BoardView, GlobView } from '../src/lib/api';
import { board as coreBoard, glob as coreGlob } from '../../../packages/core/test/fixtures';

const board: BoardView = { ...coreBoard, role: 'dev' };

const view = (patch: Partial<GlobView> = {}): GlobView => ({
  ...coreGlob(),
  list: 'planning',
  branch: 's1t1',
  currentRun: null,
  ...patch,
});

const callbacks = () => ({
  onClose: vi.fn(),
  onUpdate: vi.fn(() => Promise.resolve(null)),
  onReload: vi.fn(() => Promise.resolve()),
  onAction: vi.fn<(action: Action, anyway?: boolean) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
  onReviewLabel: vi.fn(),
  onDismissEdge: vi.fn(() => Promise.resolve(true)),
  onAddStep: vi.fn(() => Promise.resolve(true)),
  onCompleteStep: vi.fn(() => Promise.resolve(true)),
  onDismissStep: vi.fn(() => Promise.resolve(true)),
  onDecide: vi.fn(() => Promise.resolve(true)),
  onDelete: vi.fn(() => Promise.resolve()),
});

/** Renders the glob view with stubbed callbacks; the server is never reached (every fetch fails and the queries stay empty). */
const renderGlob = (glob: GlobView) => {
  const cb = callbacks();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobDetail board={board} glob={glob} initialArtifact={null} {...cb} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return cb;
};

beforeAll(() => {
  // jsdom lacks these; Radix and the glob view call them.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('no server in component tests'))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('glob view: escalation, dependencies and edit fields', () => {
  it('shows why the glob needs a person', () => {
    renderGlob(
      view({
        escalation: {
          at: '2026-10-13T00:00:00Z',
          by: 'dev@example.com',
          reason: 'Touches auth',
          criterion: 'risk_area',
        },
      }),
    );
    expect(screen.getByTestId('escalation-note').textContent).toContain('Touches auth');
  });

  it('leaves the escalation section empty without an escalation', () => {
    renderGlob(view());
    expect(screen.queryByTestId('escalation-note')).toBeNull();
  });

  it('lets a glob in Planning edit what it waits for', async () => {
    renderGlob(view({ status: 'planning', provisioning: 'none' }));
    expect(screen.getByTestId('dependencies')).toBeTruthy();
    await userEvent.type(screen.getByPlaceholderText('s15t7, s15b18'), 's1t2');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('offers Save and Discard once the group is edited, and Discard clears them', async () => {
    renderGlob(view());
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await userEvent.type(screen.getByLabelText('Group'), 'x');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('saves the edited group through onUpdate', async () => {
    const cb = renderGlob(view());
    await userEvent.type(screen.getByLabelText('Group'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(cb.onUpdate).toHaveBeenCalledWith({ group: 'x' });
  });
});
