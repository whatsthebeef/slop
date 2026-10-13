// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Action } from '@slop/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobDetail } from '../src/components/glob-dialog';
import type { BoardView, GlobView } from '../src/lib/api';
import { startAgainConfirmation } from '../src/lib/start-again';
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
  onDecide: vi.fn(() => Promise.resolve(true)),
  onDelete: vi.fn(() => Promise.resolve()),
  onAddStep: vi.fn(() => Promise.resolve(true)),
  onCompleteStep: vi.fn(() => Promise.resolve(true)),
  onDismissStep: vi.fn(() => Promise.resolve(true)),
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

const mainButton = () => screen.queryByTestId('main-action');

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

describe('glob view: main button', () => {
  it('is Start with the machine icon for a same in Planning', () => {
    renderGlob(view({ allowedActions: ['start', 'pick_up', 'delete'] }));
    const main = mainButton();
    expect(main?.textContent).toBe('Start');
    expect(main?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('is Merge for a ready PR whose checks passed', () => {
    renderGlob(
      view({
        status: 'pr_open',
        list: 'reviewing',
        pr: { number: 7, state: 'ready', headSha: 'aaa' },
        allowedActions: ['merge', 'start_again', 'delete'],
      }),
    );
    expect(mainButton()?.textContent).toBe('Merge');
  });

  it('is Fix checks when the checks failed', () => {
    renderGlob(
      view({
        status: 'pr_open',
        list: 'reviewing',
        pr: { number: 7, state: 'ready', headSha: 'aaa' },
        allowedActions: ['retry_autofix', 'start_again', 'delete'],
      }),
    );
    expect(mainButton()?.textContent).toBe('Fix checks');
  });

  it('is absent when no allowed action qualifies, leaving More', () => {
    renderGlob(view({ allowedActions: ['investigate', 'delete'] }));
    expect(mainButton()).toBeNull();
    expect(screen.getByTestId('more-actions')).toBeTruthy();
  });

  it('calls onAction with the action when clicked', async () => {
    const cb = renderGlob(view({ allowedActions: ['start', 'delete'] }));
    await userEvent.click(screen.getByTestId('main-action'));
    expect(cb.onAction).toHaveBeenCalledWith('start');
  });
});

describe('glob view: More ▾', () => {
  const planning = () => view({ allowedActions: ['start', 'investigate', 'pick_up', 'delete'] });

  it('lists the other allowed actions with their descriptions, not the main one', async () => {
    renderGlob(planning());
    await userEvent.click(screen.getByTestId('more-actions'));
    const menu = await screen.findByTestId('more-menu');
    expect(within(menu).getByTestId('more-investigate').textContent).toContain('Investigate plan');
    expect(within(menu).getByTestId('more-investigate').textContent).toContain(
      'Reads the plan and the code and attaches proposals; no branch or commits',
    );
    expect(within(menu).getByTestId('more-pick_up').textContent).toContain(
      'You implement it in your own session',
    );
    expect(within(menu).queryByTestId('more-start')).toBeNull();
  });

  it('runs the chosen action and closes', async () => {
    const cb = renderGlob(planning());
    await userEvent.click(screen.getByTestId('more-actions'));
    await userEvent.click(await screen.findByTestId('more-investigate'));
    expect(cb.onAction).toHaveBeenCalledWith('investigate');
    await waitFor(() => expect(screen.queryByTestId('more-menu')).toBeNull());
  });

  it('opens with Enter, moves with ArrowDown, and closes with Esc returning focus to the button', async () => {
    const user = userEvent.setup();
    const cb = renderGlob(planning());
    const trigger = screen.getByTestId('more-actions');
    trigger.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByTestId('more-menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(1);
    // Opening with the keyboard puts focus on the first entry; ArrowDown moves to the next.
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('more-menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);
    // Esc closed the menu only; it did not take the person back to the board.
    expect(cb.onClose).not.toHaveBeenCalled();
  });
});

describe('glob view: Reset', () => {
  const discardable = () =>
    view({
      type: 'same',
      status: 'pr_open',
      list: 'reviewing',
      branch: 's1t1',
      pr: { number: 7, state: 'ready', headSha: 'aaa' },
      allowedActions: ['merge', 'start_again', 'delete'],
    });

  it('asks before Discard and only Confirm calls start_again', async () => {
    const glob = discardable();
    const cb = renderGlob(glob);
    const area = screen.getByTestId('reset-area');
    await userEvent.click(within(area).getByTestId('reset-start_again'));
    expect(cb.onAction).not.toHaveBeenCalled();
    expect(screen.getByTestId('start-again-says').textContent).toBe(
      startAgainConfirmation(glob, board.baseBranch),
    );
    await userEvent.click(within(area).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('start-again-says')).toBeNull();
    expect(cb.onAction).not.toHaveBeenCalled();

    await userEvent.click(within(area).getByTestId('reset-start_again'));
    await userEvent.click(screen.getByTestId('confirm-start-again'));
    expect(cb.onAction).toHaveBeenCalledTimes(1);
    expect(cb.onAction).toHaveBeenCalledWith('start_again');
  });

  it('asks before Delete and only confirming calls onDelete', async () => {
    const cb = renderGlob(discardable());
    const area = screen.getByTestId('reset-area');
    await userEvent.click(within(area).getByRole('button', { name: /^Delete…/ }));
    expect(cb.onDelete).not.toHaveBeenCalled();
    expect(within(area).getByText(/permanently\?/)).toBeTruthy();
    await userEvent.click(within(area).getByRole('button', { name: 'Keep it' }));
    expect(cb.onDelete).not.toHaveBeenCalled();

    await userEvent.click(within(area).getByRole('button', { name: /^Delete…/ }));
    await userEvent.click(within(area).getByRole('button', { name: 'Delete permanently' }));
    expect(cb.onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('glob view: a decision in Doing', () => {
  it('has a Decide main button that focuses the first outcome button', async () => {
    const decision = view({
      category: 'decision',
      status: 'in_progress',
      list: 'doing',
      branch: '',
      pr: null,
      // Only Decide: an agent-submitted decision picked up by its own implementer has nothing else to do.
      allowedActions: ['decide'],
      attributes: {
        scope: { kind: 'project', ref: null },
        origin: { kind: 'submitted' },
        channel: 'human',
        outcome: null,
      },
    });
    const cb = renderGlob(decision);
    const main = screen.getByTestId('main-action');
    expect(main.textContent).toContain('Decide');
    const outcomes = await screen.findByTestId('outcomes');
    await userEvent.click(main);
    const first = within(outcomes)
      .getAllByRole('button')
      .find((b) => !b.hasAttribute('disabled'));
    expect(first).toBeTruthy();
    expect(document.activeElement).toBe(first);
    // Decide only moves focus to the panel; it never calls the server by itself.
    expect(cb.onAction).not.toHaveBeenCalled();
  });
});
