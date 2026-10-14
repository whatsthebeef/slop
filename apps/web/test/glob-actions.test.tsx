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
  onDismissEdge: vi.fn(() => Promise.resolve(true)),
  onDismiss: vi.fn(() => Promise.resolve(true)),
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

const run = (patch: Partial<NonNullable<GlobView['currentRun']>> = {}): NonNullable<GlobView['currentRun']> => ({
  id: 'r1',
  state: 'ended',
  outcome: null,
  generation: 1,
  triggeredBy: 'a@b.c',
  routineOwner: 'a@b.c',
  queuedAt: '2026-10-14T00:00:00Z',
  startedAt: null,
  lastProgressAt: null,
  endedAt: null,
  failureReason: null,
  sessionId: null,
  sessionUrl: null,
  ...patch,
});

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
        headChecks: { sha: 'aaa', state: 'passed' },
        allowedActions: ['merge', 'start_again', 'delete'],
      }),
    );
    const main = mainButton();
    expect(main?.textContent).toBe('Merge');
    expectMachineIcon(main);
  });

  it('is Merge when checks pass while the checks are pending', () => {
    renderGlob(
      view({
        status: 'pr_open',
        list: 'reviewing',
        pr: { number: 7, state: 'ready', headSha: 'aaa' },
        headChecks: { sha: 'aaa', state: 'pending' },
        allowedActions: ['merge', 'start_again', 'delete'],
      }),
    );
    const main = mainButton();
    expect(main?.textContent).toBe('Merge when checks pass');
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

  it('promotes Review code to main, with no ▾, when it is the only action left', () => {
    renderGlob(view({ allowedActions: ['review_now', 'delete'] }));
    expect(mainButton()?.textContent).toBe('Review code');
    expect(screen.queryByTestId('more-actions')).toBeNull();
  });

  it('renders no actions when only Reset actions are allowed', () => {
    renderGlob(view({ allowedActions: ['delete'] }));
    expect(mainButton()).toBeNull();
    expect(screen.queryByTestId('more-actions')).toBeNull();
    expect(screen.queryByTestId('glob-actions')).toBeNull();
  });

  it('while merging, Cancel merge leads and the ▾ holds Review code and Pick up', async () => {
    const user = userEvent.setup();
    renderGlob(
      view({
        status: 'pr_open',
        list: 'doing',
        allowedActions: ['cancel_merge', 'review_now', 'take_over', 'delete'],
      }),
    );
    expect(mainButton()?.textContent).toBe('Cancel merge');
    await user.click(screen.getByTestId('more-actions'));
    expect(await screen.findByTestId('more-review_now')).toBeTruthy();
    expect(screen.getByTestId('more-take_over')).toBeTruthy();
    expect(screen.queryByTestId('more-cancel_merge')).toBeNull();
  });

  it('is a split button: the main action with an icon-only ▾ joined to it', () => {
    renderGlob(view({ allowedActions: ['start', 'investigate', 'delete'] }));
    const split = screen.getByTestId('split-button');
    const trigger = within(split).getByTestId('more-actions');
    expect(within(split).getByTestId('main-action').textContent).toBe('Start');
    expect(trigger.getAttribute('aria-label')).toBe('More actions');
    expect(trigger.textContent).toBe('');
    expect(screen.queryByText('More')).toBeNull();
  });

  it('has no ▾ when the main action is the only one', () => {
    renderGlob(view({ allowedActions: ['start', 'delete'] }));
    expect(mainButton()).toBeTruthy();
    expect(screen.queryByTestId('more-actions')).toBeNull();
  });

  it('keeps Pick up reachable while the machine works: Review code leads, Pick up is in the ▾', async () => {
    const user = userEvent.setup();
    renderGlob(
      view({
        status: 'in_progress',
        list: 'doing',
        currentRun: run({ state: 'active' }),
        runs: [run({ state: 'ended', outcome: 'failed' }), run({ state: 'active' })],
        allowedActions: ['review_now', 'take_over', 'delete'],
      }),
    );
    expect(mainButton()?.textContent).toBe('Review code');
    await user.click(screen.getByTestId('more-actions'));
    expect((await screen.findByTestId('more-take_over')).textContent).toContain('Pick up');
  });

  describe('Pick up while the machine implements', () => {
    const implementing = (patch: Partial<GlobView> = {}) =>
      view({
        type: 'same',
        status: 'implementing',
        list: 'doing',
        branch: 's1t1',
        currentRun: run({ state: 'active' }),
        allowedActions: ['review_now', 'take_over', 'delete'],
        ...patch,
      });
    const press = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByTestId('main-action'));

    it('leads on a same, with Review code in the ▾', async () => {
      const user = userEvent.setup();
      renderGlob(implementing());
      expect(mainButton()?.textContent).toBe('Pick up');
      await user.click(screen.getByTestId('more-actions'));
      expect(await screen.findByTestId('more-review_now')).toBeTruthy();
    });

    it('is unchanged on a sub', () => {
      renderGlob(implementing({ type: 'sub' }));
      expect(mainButton()?.textContent).toBe('Review code');
    });

    it('asks first: the branch and the command, and Cancel does nothing', async () => {
      const user = userEvent.setup();
      const cb = renderGlob(implementing());
      await press(user);
      expect(cb.onAction).not.toHaveBeenCalled();
      expect(screen.getByTestId('take-over-confirmation').textContent).toContain('Pick up s1t1 from the machine?');
      expect(screen.getByTestId('take-over-happens').textContent).toContain("The machine's run is stopped");
      expect(screen.getByTestId('take-over-happens').textContent).toContain('branch s1t1');
      expect(screen.getByTestId('take-over-command').textContent).toBe('sstor --glob s1t1');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('take-over-confirmation')).toBeNull();
      expect(cb.onAction).not.toHaveBeenCalled();
    });

    it('takes over once when confirmed', async () => {
      const user = userEvent.setup();
      const cb = renderGlob(implementing());
      await press(user);
      await user.click(screen.getByTestId('confirm-take-over'));
      await waitFor(() => expect(cb.onAction).toHaveBeenCalledTimes(1));
      expect(cb.onAction).toHaveBeenCalledWith('take_over');
    });

    it('says nothing about a run that is not live', async () => {
      const user = userEvent.setup();
      renderGlob(implementing({ currentRun: run({ state: 'watching' }) }));
      await press(user);
      expect(screen.getByTestId('take-over-happens').textContent).not.toMatch(/run is stopped|cancelled/);
      expect(screen.getByTestId('take-over-happens').textContent).toContain('commits so far stay');
    });

    it('keeps the handover brief in the confirmation', async () => {
      const user = userEvent.setup();
      renderGlob(implementing({ handover: { why: ['Checks failed.'], next: 'Fix them.', detail: [] } }));
      await press(user);
      expect(screen.getByTestId('handover-confirmation').textContent).toContain('taking over because: Checks failed.');
    });

    it('says a queued run is cancelled', async () => {
      const user = userEvent.setup();
      renderGlob(implementing({ currentRun: run({ state: 'queued' }) }));
      await press(user);
      expect(screen.getByTestId('take-over-happens').textContent).toContain('The queued run is cancelled');
    });
  });

  it('keeps Retry as main after the first failure', () => {
    renderGlob(
      view({
        status: 'in_progress',
        list: 'doing',
        runs: [run({ state: 'ended', outcome: 'failed' })],
        allowedActions: ['retrigger', 'pick_up', 'delete'],
      }),
    );
    expect(mainButton()?.textContent).toBe('Retry');
  });

  it('makes Pick up the main action after a retry fails again, with Retry in the menu', async () => {
    const user = userEvent.setup();
    renderGlob(
      view({
        status: 'in_progress',
        list: 'doing',
        runs: [run({ state: 'ended', outcome: 'failed' }), run({ state: 'ended', outcome: 'failed' })],
        allowedActions: ['retrigger', 'pick_up', 'delete'],
      }),
    );
    expect(mainButton()?.textContent).toBe('Pick up');
    await user.click(screen.getByTestId('more-actions'));
    const menu = await screen.findByTestId('more-menu');
    expect(within(menu).getByTestId('more-retrigger').textContent).toContain('Retry');
    expect(within(menu).queryByTestId('more-pick_up')).toBeNull();
    expect(within(menu).queryByTestId('more-start_again')).toBeNull();
  });

  it('calls onAction with the action when clicked', async () => {
    const user = userEvent.setup();
    const cb = renderGlob(view({ allowedActions: ['start', 'delete'] }));
    await user.click(screen.getByTestId('main-action'));
    expect(cb.onAction).toHaveBeenCalledWith('start');
  });
});

describe('glob view: ▾ menu', () => {
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

describe('a due rollout step is the main action, never a scroll-only button', () => {
  const dueStep = (patch: Record<string, unknown> = {}) =>
    ({
      id: 'hs_1',
      kind: 'rollout',
      title: 'Add SLOP_X to the server env',
      state: 'due',
      who: 'anyone',
      due: 'after_merge',
      blocks: ['sign_off', 'dependants'],
      detail: null,
      script: null,
      check: null,
      source: 'work',
      doneBy: null,
      doneAt: null,
      ...patch,
    }) as NonNullable<GlobView['humanSteps']>[number];
  const renderMerged = (step: ReturnType<typeof dueStep>) => {
    const cb = callbacks();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <GlobDetail
            board={{ ...board, role: 'admin' }}
            glob={view({ status: 'reviewing', list: 'reviewing', pr: { number: 7, state: 'merged', headSha: 'abc' }, humanSteps: [step] })}
            initialArtifact={null}
            email="admin@example.com"
            {...cb}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return cb;
  };

  it('a setting step is Mark done, which ticks the step', async () => {
    const user = userEvent.setup();
    const cb = renderMerged(dueStep({ kind: 'rollout', detail: 'Set it in prod' }));
    const main = screen.getByTestId('main-action');
    expect(main.textContent).toContain('Mark done');
    expect(screen.getByTestId('main-action-note').textContent).toContain('Set it in prod');
    await user.click(main);
    expect(cb.onCompleteStep).toHaveBeenCalledWith('hs_1');
  });

  it('a script step is Copy rollout command, then Mark done', async () => {
    const user = userEvent.setup();
    const cb = renderMerged(dueStep({ script: { path: 'infra/deploy/host-deploy.sh' } }));
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    expect(screen.getByTestId('main-action').textContent).toContain('Copy rollout command');
    await user.click(screen.getByTestId('main-action'));
    expect(write).toHaveBeenCalledWith('infra/deploy/host-deploy.sh');
    await waitFor(() => expect(screen.getByTestId('main-action').textContent).toContain('Mark done'));
    await user.click(screen.getByTestId('main-action'));
    expect(cb.onCompleteStep).toHaveBeenCalledWith('hs_1');
  });

  it('a step with a capability check is disabled, with the reason', () => {
    const cb = renderMerged(dueStep({ check: 'fileAttachments' }));
    const main = screen.getByTestId('main-action');
    expect((main as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('main-action-note').textContent).toContain('waits for fileAttachments to turn on; slop ticks this itself');
    expect(cb.onCompleteStep).not.toHaveBeenCalled();
  });
});

describe('glob view: the conflict section', () => {
  const section = () => document.querySelector('[data-section="conflict"]') as HTMLElement;

  it('lists the files and the cause of a conflict with the base, which the card leaves out', () => {
    const files = ['apps/web/src/a.ts', 'apps/web/src/b.ts'];
    renderGlob(
      view({
        status: 'pr_open',
        list: 'doing',
        pr: { number: 7, state: 'ready', headSha: 'abc1234' },
        conflict: { base: 'main', files, since: 's1t9', at: '2026-01-01T00:00:00Z' },
      }),
    );
    const facts = within(section()).getByTestId('conflict-facts');
    expect(facts.textContent).toContain('conflicts with main, since s1t9 merged');
    expect(within(section()).getByTestId('conflict-files').textContent).toBe(`Files changed on both sides (2)${files.join('')}`);
  });

  it("shows a clash with another glob and the files both change, even with no implementer", () => {
    renderGlob(view({ status: 'planning', clash: { with: 's1t2', paths: ['apps/web/src/c.ts'] } }));
    const clash = within(section()).getByTestId('conflict-clash');
    expect(clash.textContent).toContain('s1t2 also changes some of the same files');
    expect(clash.textContent).toContain('apps/web/src/c.ts');
  });
});
