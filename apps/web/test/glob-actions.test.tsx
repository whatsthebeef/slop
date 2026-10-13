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

/** The main button shows the machine icon (lucide Bot) and not the human one. */
const expectMachineIcon = (button: HTMLElement | null) => {
  expect(button?.querySelector('svg.lucide-bot')).not.toBeNull();
  expect(button?.querySelector('svg.lucide-user-round')).toBeNull();
};

/** Adds an Element method jsdom lacks, leaving any real one in place. */
const polyfill = (name: string, value: () => unknown) => {
  if (!(name in Element.prototype)) {
    Object.defineProperty(Element.prototype, name, { value, configurable: true, writable: true });
  }
};

beforeAll(() => {
  // jsdom lacks these; Radix and the glob view call them.
  polyfill('scrollIntoView', () => undefined);
  polyfill('hasPointerCapture', () => false);
  polyfill('setPointerCapture', () => undefined);
  polyfill('releasePointerCapture', () => undefined);
});

beforeEach(() => {
  // Stubbed per test so `unstubAllGlobals` in afterEach always pairs with them, whatever the order.
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
    expectMachineIcon(main);
  });

  it('is Merge for a ready PR whose checks passed', () => {
    renderGlob(
      view({
        status: 'pr_open',
        list: 'reviewing',
        pr: { number: 7, state: 'ready', headSha: 'aaa' },
        // GlobView has no checks field: the server reflects passed checks by allowing merge.
        allowedActions: ['merge', 'start_again', 'delete'],
      }),
    );
    const main = mainButton();
    expect(main?.textContent).toBe('Merge');
    expectMachineIcon(main);
  });

  it('is Fix checks when the checks failed', () => {
    renderGlob(
      view({
        status: 'pr_open',
        list: 'reviewing',
        pr: { number: 7, state: 'ready', headSha: 'aaa' },
        // GlobView has no checks field: the server reflects failed checks by allowing retry_autofix.
        allowedActions: ['retry_autofix', 'start_again', 'delete'],
      }),
    );
    const main = mainButton();
    expect(main?.textContent).toBe('Fix checks');
    expectMachineIcon(main);
  });

  it('is absent when no allowed action qualifies, leaving More', () => {
    renderGlob(view({ allowedActions: ['investigate', 'delete'] }));
    expect(mainButton()).toBeNull();
    expect(screen.getByTestId('more-actions')).toBeTruthy();
  });

  it('calls onAction with the action when clicked', async () => {
    const user = userEvent.setup();
    const cb = renderGlob(view({ allowedActions: ['start', 'delete'] }));
    await user.click(screen.getByTestId('main-action'));
    expect(cb.onAction).toHaveBeenCalledWith('start');
  });
});

describe('glob view: More ▾', () => {
  const planning = () => view({ allowedActions: ['start', 'investigate', 'pick_up', 'delete'] });

  it('lists the other allowed actions with their descriptions, not the main one', async () => {
    const user = userEvent.setup();
    renderGlob(planning());
    await user.click(screen.getByTestId('more-actions'));
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
    const user = userEvent.setup();
    const cb = renderGlob(planning());
    await user.click(screen.getByTestId('more-actions'));
    await user.click(await screen.findByTestId('more-investigate'));
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
    const user = userEvent.setup();
    const glob = discardable();
    const cb = renderGlob(glob);
    const area = screen.getByTestId('reset-area');
    await user.click(within(area).getByTestId('reset-start_again'));
    expect(cb.onAction).not.toHaveBeenCalled();
    expect(screen.getByTestId('start-again-says').textContent).toBe(
      startAgainConfirmation(glob, board.baseBranch),
    );
    await user.click(within(area).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('start-again-says')).toBeNull();
    expect(cb.onAction).not.toHaveBeenCalled();

    await user.click(within(area).getByTestId('reset-start_again'));
    await user.click(screen.getByTestId('confirm-start-again'));
    expect(cb.onAction).toHaveBeenCalledTimes(1);
    expect(cb.onAction).toHaveBeenCalledWith('start_again');
  });

  it('asks before Delete and only confirming calls onDelete', async () => {
    const user = userEvent.setup();
    const cb = renderGlob(discardable());
    const area = screen.getByTestId('reset-area');
    await user.click(within(area).getByRole('button', { name: /^Delete…/ }));
    expect(cb.onDelete).not.toHaveBeenCalled();
    expect(within(area).getByText(/permanently\?/)).toBeTruthy();
    await user.click(within(area).getByRole('button', { name: 'Keep it' }));
    expect(cb.onDelete).not.toHaveBeenCalled();

    await user.click(within(area).getByRole('button', { name: /^Delete…/ }));
    await user.click(within(area).getByRole('button', { name: 'Delete permanently' }));
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
    const user = userEvent.setup();
    const cb = renderGlob(decision);
    const main = screen.getByTestId('main-action');
    expect(main.textContent).toContain('Decide');
    const outcomes = await screen.findByTestId('outcomes');
    await user.click(main);
    const first = within(outcomes)
      .getAllByRole('button')
      .find((b) => !b.hasAttribute('disabled'));
    expect(first).toBeTruthy();
    expect(document.activeElement).toBe(first);
    // Decide only moves focus to the panel; it never calls the server by itself.
    expect(cb.onAction).not.toHaveBeenCalled();
  });
});
