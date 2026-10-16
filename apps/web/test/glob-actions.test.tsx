// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Action } from '@slop/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobDetail } from '../src/components/glob-dialog';
import { api } from '../src/lib/api';
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
  onAction: vi.fn<(action: Action, anyway?: boolean, text?: string) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
  onReviewLabel: vi.fn(),
  onDismissEdge: vi.fn(() => Promise.resolve(true)),
  onAddRelation: vi.fn(() => Promise.resolve(true)),
  onAnswerQuestion: vi.fn(() => Promise.resolve(true)),
  onDismissQuestion: vi.fn(() => Promise.resolve(true)),
  onDismiss: vi.fn(() => Promise.resolve(true)),
  onDecide: vi.fn(() => Promise.resolve(true)),
  onDelete: vi.fn(() => Promise.resolve()),
  onAddStep: vi.fn(() => Promise.resolve(true)),
  onCompleteStep: vi.fn(() => Promise.resolve(true)),
  onDismissStep: vi.fn(() => Promise.resolve(true)),
  onFailStep: vi.fn(() => Promise.resolve(true)),
});

/** Renders the glob view with stubbed callbacks; the server is never reached (every fetch fails and the queries stay empty). */
const renderGlob = (glob: GlobView, as: BoardView = board) => {
  const cb = callbacks();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobDetail board={as} glob={glob} initialArtifact={null} {...cb} />
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
  vi.restoreAllMocks();
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

  it("promotes a person's Review code to main, with no ▾, only when it is the only action left", () => {
    renderGlob(view({ implementer: 'a@b.c', allowedActions: ['review_now', 'delete'] }));
    expect(mainButton()?.textContent).toBe('Review code');
    expect(screen.queryByTestId('more-actions')).toBeNull();
  });

  it('promotes Retry review when the automatic review is missing and nothing else leads', () => {
    renderGlob(
      view({
        type: 'sub',
        status: 'reviewing',
        list: 'reviewing',
        pr: { number: 7, state: 'merged', headSha: 'abc' },
        artifacts: [],
        allowedActions: ['review_now', 'delete'],
      }),
    );
    expect(mainButton()?.textContent).toBe('Retry review');
  });

  it("keeps a person's Review code in the ▾, behind Pick up", async () => {
    const user = userEvent.setup();
    renderGlob(
      view({
        status: 'in_progress',
        list: 'doing',
        implementer: 'a@b.c',
        pr: { number: 7, state: 'draft', headSha: 'abc' },
        allowedActions: ['review_now', 'pick_up', 'delete'],
      }),
    );
    expect(mainButton()?.textContent).not.toMatch(/Review/);
    await user.click(screen.getByTestId('more-actions'));
    expect((await screen.findByTestId('more-review_now')).textContent).toContain('Review code');
  });

  it('renders no actions when only Reset actions are allowed', () => {
    renderGlob(view({ allowedActions: ['delete'] }));
    expect(mainButton()).toBeNull();
    expect(screen.queryByTestId('more-actions')).toBeNull();
    expect(within(screen.getByTestId('glob-actions')).queryAllByRole('button')).toHaveLength(0);
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

  it('keeps Pick up reachable while the machine works, as the main with no Review code', () => {
    renderGlob(
      view({
        status: 'in_progress',
        list: 'doing',
        currentRun: run({ state: 'active' }),
        runs: [run({ state: 'ended', outcome: 'failed' }), run({ state: 'active' })],
        allowedActions: ['take_over', 'delete'],
      }),
    );
    expect(mainButton()?.textContent).toBe('Pick up');
    expect(screen.queryByTestId('more-actions')).toBeNull();
  });

  describe('Pick up while the machine implements', () => {
    const implementing = (patch: Partial<GlobView> = {}) =>
      view({
        type: 'same',
        status: 'implementing',
        list: 'doing',
        branch: 's1t1',
        currentRun: run({ state: 'active' }),
        allowedActions: ['take_over', 'delete'],
        ...patch,
      });
    const press = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByTestId('main-action'));

    it('leads on a same, black, with no Review code', () => {
      renderGlob(implementing());
      expect(mainButton()?.textContent).toBe('Pick up');
      expect(mainButton()?.getAttribute('data-variant')).toBe('default');
      expect(screen.queryByTestId('more-review_now')).toBeNull();
    });

    it('is a quiet outline on a sub while the machine progresses', () => {
      renderGlob(implementing({ type: 'sub' }));
      expect(mainButton()?.textContent).toBe('Pick up');
      expect(mainButton()?.getAttribute('data-variant')).toBe('outline');
      expect(screen.queryByTestId('more-review_now')).toBeNull();
    });

    it('turns black on a sub once it is stalled', () => {
      renderGlob(
        implementing({
          type: 'sub',
          humanSteps: [
            {
              id: 'machine:unstick',
              kind: 'unstick',
              title: 'Open session',
              who: 'implementer',
              state: 'due',
              source: 'machine',
              action: 'open_session',
              alternative: 'take_over',
            } as unknown as NonNullable<GlobView['humanSteps']>[number],
          ],
        }),
      );
      expect(mainButton()?.getAttribute('data-variant')).toBe('default');
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
      expect(screen.getByTestId('take-over-how').textContent).toContain('copied to your clipboard when you confirm');
      expect(screen.queryByTestId('take-over-copy')).toBeNull();
      expect(within(screen.getByTestId('take-over-confirmation')).queryByRole('button', { name: 'Copy' })).toBeNull();
      expect(screen.getByTestId('confirm-take-over').textContent).toBe('Confirm pick up');
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

  it('shows only its buttons, with no "Reset" heading', () => {
    renderGlob(discardable());
    const area = screen.getByTestId('reset-area');
    expect(within(area).queryByText('Reset')).toBeNull();
    expect(within(area).getByTestId('reset-start_again')).toBeTruthy();
    expect(within(area).getByRole('button', { name: /^Delete…/ })).toBeTruthy();
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

  it('renders no red area when the viewer has no destructive action', () => {
    renderGlob(
      view({
        type: 'same',
        status: 'pr_open',
        list: 'reviewing',
        branch: 's1t1',
        pr: { number: 7, state: 'ready', headSha: 'aaa' },
        allowedActions: ['merge'],
      }),
    );
    expect(screen.queryByTestId('reset-area')).toBeNull();
  });

  it('offers Delete on a learning, warning that Reject is what stops repeats', async () => {
    const user = userEvent.setup();
    const cb = renderGlob(
      view({
        category: 'decision',
        status: 'in_progress',
        list: 'doing',
        branch: '',
        pr: null,
        allowedActions: ['delete'],
        attributes: {
          scope: { kind: 'project', ref: null },
          origin: { kind: 'submitted' },
          channel: 'human',
          outcome: null,
        },
      }),
    );
    const area = screen.getByTestId('reset-area');
    await user.click(within(area).getByRole('button', { name: /^Delete…/ }));
    expect((await screen.findByTestId('delete-learning-warning')).textContent).toContain(
      'Deleting forgets this learning. If slop spots the same thing again, it comes back as new. To say no and stop repeats, use Reject instead.',
    );
    const live = () => within(screen.getByTestId('reset-area'));
    await user.click(live().getByRole('button', { name: 'Cancel' }));
    expect(cb.onDelete).not.toHaveBeenCalled();
    await user.click(live().getByRole('button', { name: /^Delete…/ }));
    await user.click(live().getByRole('button', { name: 'Delete permanently' }));
    expect(cb.onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('glob view: a decision in Doing', () => {
  const decision = (patch: Partial<GlobView> = {}) =>
    view({
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
      ...patch,
    });

  it('has no primary or ▾ in the action row: the one Approve change is in the decision block, which opens the approval', async () => {
    const user = userEvent.setup();
    const cb = renderGlob(decision());
    expect(screen.queryByText('Decide')).toBeNull();
    const outcomes = await screen.findByTestId('outcomes');
    expect(screen.queryByTestId('main-action')).toBeNull();
    expect(screen.queryByTestId('more-actions')).toBeNull();
    expect(within(screen.getByTestId('decision-block')).getByTestId('outcomes')).toBe(outcomes);
    expect(screen.getAllByRole('button', { name: 'Approve change' })).toHaveLength(1);
    await user.click(within(outcomes).getByRole('button', { name: 'Approve change' }));
    expect(await screen.findByTestId('outcome-form-accept')).toBeTruthy();
    // Opening the form decides nothing; it never calls the server by itself.
    expect(cb.onAction).not.toHaveBeenCalled();
    expect(cb.onDecide).not.toHaveBeenCalled();
  });

  it('lists Reject…, approve with edits, keeping the statement and a new recommendation in the block’s ▾ for an admin', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'globDiff').mockResolvedValue({
      target: null,
      currentVersion: null,
      preview: null,
      draft: null,
      learning: { status: 'open', processing: 'drafted', processingError: null, processingAttempts: 0, processAfter: null, effectCheck: null },
    });
    renderGlob(decision(), { ...board, role: 'admin' });
    await user.click(await screen.findByTestId('more-outcomes'));
    const menu = await screen.findByTestId('outcomes-menu');
    await waitFor(() => expect(within(menu).getByText('Approve without changing a document')).toBeTruthy());
    expect(within(menu).getByText('Reject…')).toBeTruthy();
    expect(within(menu).getByText('Get a new recommendation')).toBeTruthy();
    // Nothing the old Decide panel offered is lost.
    expect(within(menu).getByText('Approve with edits…')).toBeTruthy();
    expect(within(menu).getByText('Retarget')).toBeTruthy();
    expect(within(menu).getByText('Needs work')).toBeTruthy();
  });

  it('opens the reject reason in the body from the block’s menu', async () => {
    const user = userEvent.setup();
    renderGlob(decision());
    await user.click(await screen.findByTestId('more-outcomes'));
    await user.click(await screen.findByTestId('outcome-reject'));
    expect(await screen.findByTestId('outcome-form-reject')).toBeTruthy();
  });

  it('shows why a PO cannot approve a merge policy instead of the button', async () => {
    vi.spyOn(api, 'globDiff').mockResolvedValue({
      target: { kind: 'merge_policy', name: 'merge_policy', section: null, newDocument: null },
      currentVersion: null,
      preview: null,
      draft: null,
      learning: null,
    });
    renderGlob(decision(), { ...board, role: 'po' });
    const blocked = await screen.findByTestId('approve-blocked');
    expect(blocked.textContent).toContain('it changes the merge policy');
    expect(screen.getByTestId('outcome-accept')).toHaveProperty('disabled', true);
    expect(screen.queryByTestId('main-action')).toBeNull();
  });

  it('shows the block in Planning with no outcomes, and Pick up as the primary', async () => {
    renderGlob(decision({ status: 'planning', list: 'planning', allowedActions: ['pick_up', 'delete'] }));
    expect(await screen.findByTestId('decision-block')).toBeTruthy();
    expect(screen.queryByTestId('outcomes')).toBeNull();
    expect(screen.queryByTestId('more-outcomes')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reject/ })).toBeNull();
    expect(mainButton()?.textContent).toMatch(/Pick up/);
  });

  it('hides a replacement’s Confirm and Dismiss in Planning, and shows them once picked up', async () => {
    const replacement = {
      scope: { kind: 'project', ref: null },
      origin: { kind: 'replacement', oldId: 'd1', newId: 'd2' },
      channel: 'agent',
      outcome: null,
    } as unknown as NonNullable<GlobView['attributes']>;
    const as = { ...board, role: 'admin' } as const;
    renderGlob(decision({ status: 'planning', list: 'planning', allowedActions: ['pick_up'], attributes: replacement }), as);
    await screen.findByTestId('decision-section');
    expect(screen.queryByTestId('replacement-outcomes')).toBeNull();
    cleanup();
    renderGlob(decision({ attributes: replacement }), as);
    expect(await screen.findByTestId('replacement-confirm')).toBeTruthy();
    expect(screen.getByTestId('replacement-dismiss')).toBeTruthy();
  });

  it('shows ⋯ with Take over, and no primary, only while the decision blocks', async () => {
    const user = userEvent.setup();
    renderGlob(decision({ allowedActions: ['decide', 'take_over'] }));
    await screen.findByTestId('outcomes');
    expect(screen.queryByTestId('main-action')).toBeNull();
    await user.click(screen.getByTestId('more-escape'));
    expect(await screen.findByTestId('more-take_over')).toBeTruthy();
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

  it('has no primary or ▾ in the row; a setting step is ticked with Done in the step block', async () => {
    const user = userEvent.setup();
    const cb = renderMerged(dueStep({ kind: 'rollout', detail: 'Set it in prod' }));
    expect(screen.queryByTestId('main-action')).toBeNull();
    expect(screen.queryByTestId('more-actions')).toBeNull();
    expect(screen.queryByTestId('main-action-note')).toBeNull();
    await user.click(within(screen.getByTestId('due-step')).getByTestId('due-done'));
    expect(cb.onCompleteStep).toHaveBeenCalledWith('hs_1');
  });

  it('a script step is copied from the step block, then ticked with Done', async () => {
    const user = userEvent.setup();
    const cb = renderMerged(dueStep({ script: { path: 'infra/deploy/host-deploy.sh' } }));
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    expect(screen.queryByTestId('main-action')).toBeNull();
    await user.click(screen.getByTestId('step-copy'));
    expect(write).toHaveBeenCalledWith('bash infra/deploy/host-deploy.sh');
    await user.click(screen.getByTestId('due-done'));
    expect(cb.onCompleteStep).toHaveBeenCalledWith('hs_1');
  });

  it('a step with a capability check has Done disabled, with the reason, and no primary', () => {
    const cb = renderMerged(dueStep({ check: 'fileAttachments' }));
    expect(screen.queryByTestId('main-action')).toBeNull();
    expect(screen.getByTestId<HTMLButtonElement>('due-done').disabled).toBe(true);
    expect(screen.getByTestId('step-check').textContent).toContain('waits for fileAttachments to turn on; slop ticks this itself');
    expect(cb.onCompleteStep).not.toHaveBeenCalled();
  });

  it('brings the primary back once the step is done', () => {
    const merged = { number: 7, state: 'merged', headSha: 'abc' } as const;
    const done = dueStep({ state: 'done', doneBy: 'admin@example.com', doneAt: '2026-10-14T00:00:00Z' });
    renderGlob(view({ status: 'reviewing', list: 'reviewing', pr: merged, humanSteps: [done], allowedActions: ['sign_off', 'delete'] }), { ...board, role: 'admin' });
    expect(mainButton()).not.toBeNull();
  });
});

describe('glob view: a block that holds the glob replaces the primary and ▾ (s15t241)', () => {
  const ready = (patch: Partial<GlobView> = {}) =>
    view({
      status: 'pr_open',
      list: 'reviewing',
      pr: { number: 7, state: 'ready', headSha: 'aaa' },
      headChecks: { sha: 'aaa', state: 'passed' },
      allowedActions: ['merge', 'start_again', 'delete'],
      ...patch,
    });
  const raised = (patch: Partial<NonNullable<GlobView['questions']>[number]> = {}): NonNullable<GlobView['questions']>[number] => ({
    id: 'q1',
    text: 'Is prod in scope?',
    raisedBy: { kind: 'intake', actor: null },
    source: 'create',
    blocking: 'merge',
    raisedAt: '2026-10-14T00:00:00Z',
    ...patch,
  });
  const shown = (glob: GlobView) => {
    const cb = callbacks();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (g: GlobView) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <GlobDetail board={board} glob={g} initialArtifact={null} {...cb} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const out = render(tree(glob));
    return { cb, moveTo: (g: GlobView) => out.rerender(tree(g)) };
  };

  it('has no primary and no ▾ while a merge question is open, and its answer form is in the question block', () => {
    renderGlob(ready({ questions: [raised()] }));
    expect(screen.queryByTestId('main-action')).toBeNull();
    expect(screen.queryByTestId('more-actions')).toBeNull();
    expect(screen.getByRole('button', { name: 'Answer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('keeps the primary for a question that does not block', () => {
    renderGlob(ready({ questions: [raised({ blocking: 'none' })] }));
    expect(mainButton()?.textContent).toContain('Merge');
  });

  it('brings the primary back when the question is answered', () => {
    const { moveTo } = shown(ready({ questions: [raised()] }));
    expect(mainButton()).toBeNull();
    moveTo(ready({ version: 2, questions: [raised({ answer: { text: 'Yes', by: 'a@b.c', at: '2026-10-14T01:00:00Z' } })] }));
    expect(mainButton()?.textContent).toContain('Merge');
  });

  it('shows ⋯ with Take over only while blocked, and the ▾ carries it again once the block is gone', async () => {
    const user = userEvent.setup();
    const { moveTo } = shown(ready({ allowedActions: ['merge', 'take_over', 'delete'], questions: [raised()] }));
    await user.click(screen.getByTestId('more-escape'));
    expect(await screen.findByTestId('more-take_over')).toBeTruthy();
    await user.keyboard('{Escape}');
    moveTo(ready({ version: 2, allowedActions: ['merge', 'take_over', 'delete'], questions: [raised({ dismissed: { by: 'a@b.c', at: '2026-10-14T01:00:00Z', note: '' } })] }));
    expect(screen.queryByTestId('more-escape')).toBeNull();
    expect(mainButton()).not.toBeNull();
  });

  it('shows an open question in Planning with no answer or dismiss buttons, and Start as the primary', () => {
    renderGlob(view({ allowedActions: ['start', 'pick_up', 'delete'], questions: [raised({ blocking: 'none' })] }));
    expect(screen.getByTestId('question-q1').textContent).toContain('Is prod in scope?');
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(screen.queryByLabelText('Answer q1')).toBeNull();
    expect(mainButton()?.textContent).toBe('Start');
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
    expect(within(section()).getByTestId('block-head').textContent).toBe('Conflicts with main');
    expect(facts.textContent).toBe('Since s1t9 merged, both sides changed 2 files.');
    expect(within(section()).getByTestId('conflict-files').textContent).toBe(`Files changed on both sides (2)${files.join('')}`);
  });

  it("shows a clash with another glob and the files both change, even with no implementer", () => {
    renderGlob(view({ status: 'planning', clash: { with: 's1t2', paths: ['apps/web/src/c.ts'] } }));
    const clash = within(section()).getByTestId('conflict-clash');
    expect(clash.textContent).toContain('s1t2 also changes some of the same files');
    expect(clash.textContent).toContain('apps/web/src/c.ts');
  });
});

describe('glob view: split moves in the action ▾', () => {
  const now = '2026-10-14T00:00:00Z';
  const stream = (name: string, needs: number[] = []) => ({ name, goal: `goal ${name}`, files: [`apps/${name.toLowerCase()}.ts`], plan: `plan ${name}`, needs });
  const sizeCheck = (proposal: boolean): NonNullable<GlobView['sizeCheck']> => ({
    globId: 's1t1',
    boardId: 1,
    planHash: 'h',
    estimate: {
      tasks: 6,
      doneWhenLines: 6,
      areas: ['web'],
      untaskedSections: 0,
      independentParts: 3,
      partsSource: 'model',
      parallelParts: 2,
      reasoning: null,
    },
    evidence: ['6 tasks'],
    threshold: { maxParts: 3, maxTasks: 5, minParallel: 2 },
    flagged: true,
    reasons: ['6 tasks'],
    proposal: proposal ? { workstreams: [stream('One'), stream('Two', [0])] } : null,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const splittableGlob = (patch: Partial<GlobView> = {}) =>
    view({
      status: 'planning',
      provisioning: 'none',
      runs: [],
      pr: null,
      allowedActions: ['start', 'delete'],
      ...patch,
    });
  const oversizedGlob = (proposal: boolean, patch: Partial<GlobView> = {}) =>
    splittableGlob({ oversized: true, sizeCheck: sizeCheck(proposal), ...patch });

  it('has no standalone Split button; Split… is in the ▾ and opens the split form', async () => {
    const user = userEvent.setup();
    renderGlob(splittableGlob());
    expect(screen.queryByTestId('split-glob')).toBeNull();
    expect(mainButton()?.textContent).toBe('Start');
    await user.click(screen.getByTestId('more-actions'));
    await user.click(await screen.findByTestId('more-split'));
    const editor = await screen.findByTestId('split-editor');
    expect(editor.textContent).toContain('each piece ships on its own');
    expect(editor.textContent).toContain('Starts after');
    expect(editor.textContent).not.toContain('Waits for');
  });

  it('asks a group-less glob for the group its parts join, prefilled from its title', async () => {
    const user = userEvent.setup();
    renderGlob(splittableGlob({ group: null, title: 'Board chat 1/2: answers' }));
    await user.click(screen.getByTestId('more-actions'));
    await user.click(await screen.findByTestId('more-split'));
    expect((await screen.findByTestId('split-group')).getAttribute('value')).toBe('board-chat');
  });

  it("keeps a grouped glob's group without asking", async () => {
    const user = userEvent.setup();
    renderGlob(splittableGlob({ group: 'workstreams' }));
    await user.click(screen.getByTestId('more-actions'));
    await user.click(await screen.findByTestId('more-split'));
    const editor = await screen.findByTestId('split-editor');
    expect(screen.queryByTestId('split-group')).toBeNull();
    expect(editor.textContent).toContain('workstreams');
  });

  it('never holds an oversized glob: Start still leads, and Split… is a scope cut in the ▾', async () => {
    const user = userEvent.setup();
    renderGlob(oversizedGlob(true));
    expect(mainButton()?.textContent).toBe('Start');
    await user.click(screen.getByTestId('more-actions'));
    await screen.findByTestId('more-menu');
    expect(screen.getByTestId('more-split')).toBeTruthy();
    expect(screen.queryByTestId('more-keep-whole')).toBeNull();
    expect(screen.queryByTestId('more-propose-split')).toBeNull();
  });

  it('starts an oversized glob with a plain Start: no confirmation', async () => {
    const user = userEvent.setup();
    const cb = renderGlob(oversizedGlob(true));
    await user.click(mainButton() as HTMLElement);
    expect(screen.queryByTestId('confirm-start-oversized')).toBeNull();
    await waitFor(() => expect(cb.onAction).toHaveBeenCalledWith('start'));
  });

  it('keeps the explanation and the proposed workstreams in the panel, without buttons', () => {
    renderGlob(oversizedGlob(true));
    const panel = screen.getByTestId('oversized-proposal');
    expect(panel.textContent).toContain('Oversized: this looks like more than one PR');
    expect(panel.textContent).toContain('This is advice');
    expect(within(panel).getByTestId('oversized-parts').textContent).toContain('Two');
    expect(within(panel).getByTestId('oversized-parts').textContent).toContain('apps/two.ts');
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
  });

  describe('the top bar, the tags and the action line', () => {
    it('keeps the top bar to identity: ID · list; the type control sits with the group tag under the title', () => {
      renderGlob(view({ type: 'same', list: 'planning', group: 'glob-view-layout' }));
      const bar = screen.getByTestId('glob-header');
      expect(within(bar).queryByTestId('glob-type')).toBeNull();
      expect(within(bar).getByTestId('glob-list').textContent).toBe('Planning');
      const chips = screen.getByTestId('glob-chips');
      const group = within(chips).getByTestId('group-chip');
      const type = within(chips).getByTestId('glob-type');
      expect(group.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(type.textContent).toBe('same');
      expect(type.className).toContain('text-[10px]');
      expect(group.className).toContain('text-[10px]');
      expect(type.className).toContain('font-mono');
      expect(within(screen.getByTestId('glob-actions')).queryByTestId('glob-type')).toBeNull();
      expect(screen.getAllByTestId('glob-type')).toHaveLength(1);
    });

    it('puts the group tag beside the type control and nowhere else, with no label tags under the title', () => {
      renderGlob(view({ group: 'glob-view-layout', labels: { FR: 'required', CR: 'required' } }));
      const chips = screen.getByTestId('glob-chips');
      expect(within(chips).getByTestId('group-chip').textContent).toBe('glob-view-layout');
      expect(within(chips).getByTestId('group-chip').getAttribute('href')).toBe('/boards/1?group=glob-view-layout');
      expect(screen.getAllByTestId('group-chip')).toHaveLength(1);
      expect(within(screen.getByTestId('glob-actions')).queryByTestId('group-chip')).toBeNull();
      expect(screen.queryByLabelText('Sign-off labels')).toBeNull();
    });

    it('shows the Arm system label and the branch on a quiet line beside the action row, not in the top bar', () => {
      const step = { id: 'hs_1', kind: 'rollout', title: 'Run the migration', state: 'pending', who: 'admin', due: 'after_merge', blocks: ['sign_off'] } as const;
      renderGlob(view({ branch: 's1t1', humanSteps: [step] }));
      const row = screen.getByTestId('glob-actions');
      const info = within(row).getByTestId('action-line-info');
      expect(within(info).getByTestId('arm-system-label').textContent).toBe('Arm system');
      expect(within(info).getByTestId('glob-branch').textContent).toBe('s1t1');
      expect(info.className).toContain('ml-auto');
      expect(info.className).toContain('flex-wrap');
      expect(within(screen.getByTestId('glob-header')).queryByTestId('arm-system-label')).toBeNull();
      expect(within(screen.getByTestId('glob-header')).queryByTestId('glob-branch')).toBeNull();
    });
  });

  describe('the work kind control', () => {
    it('is not shown to a non-admin, and is a select an admin can use', async () => {
      const user = userEvent.setup();
      cleanup();
      renderGlob(view({ category: 'task', type: 'same' }));
      expect(screen.queryByTestId('work-kind')).toBeNull();
      cleanup();
      const cb = renderGlob(view({ category: 'task', type: 'same' }), { ...board, role: 'admin' });
      const select = screen.getByTestId<HTMLSelectElement>('work-kind');
      expect(select.disabled).toBe(false);
      await user.selectOptions(select, 'rnd');
      await waitFor(() => expect(cb.onUpdate).toHaveBeenCalledWith({ workKind: 'rnd' }));
    });
  });

  describe('an action glob (human work with no type)', () => {
    const action = (patch: Partial<GlobView> = {}): GlobView =>
      view({
        id: 's1a1',
        category: 'action',
        type: null,
        pr: null,
        provisioning: 'none',
        attributes: { assignee: null, outcome: null },
        allowedActions: ['complete_action', 'dismiss_action', 'delete'],
        ...patch,
      });

    it('shows no type control and no fix, work kind or environment fields, only the mode word in the bar', () => {
      renderGlob(action());
      const type = screen.getByTestId('glob-type');
      expect(type.textContent).toBe('action');
      expect(screen.queryByTestId('type-popover')).toBeNull();
      expect(screen.queryByTestId('fix')).toBeNull();
      expect(screen.queryByTestId('work-kind')).toBeNull();
    });

    it('leads with Done and the human icon, and keeps Dismiss… in the menu', async () => {
      const user = userEvent.setup();
      renderGlob(action());
      const main = mainButton();
      expect(main?.textContent).toBe('Done');
      expect(main?.querySelector('svg.lucide-user-round')).not.toBeNull();
      await user.click(screen.getByTestId('more-actions'));
      const menu = within(screen.getByTestId('more-menu'));
      expect(menu.getByTestId('more-dismiss_action').textContent).toContain('Dismiss…');
      expect(menu.queryByTestId('more-complete_action')).toBeNull();
    });

    it('asks for an optional note before Done, then sends it', async () => {
      const user = userEvent.setup();
      const cb = renderGlob(action());
      await user.click(mainButton() as HTMLElement);
      expect(cb.onAction).not.toHaveBeenCalled();
      const confirm = within(screen.getByTestId('done-action-confirmation'));
      await user.type(confirm.getByTestId('action-note'), 'checked the settings page');
      await user.click(confirm.getByTestId('confirm-finish-action'));
      await waitFor(() => expect(cb.onAction).toHaveBeenCalledWith('complete_action', undefined, 'checked the settings page'));
    });

    it('lets Done go with no note, and Cancel sends nothing', async () => {
      const user = userEvent.setup();
      const cb = renderGlob(action());
      await user.click(mainButton() as HTMLElement);
      await user.click(within(screen.getByTestId('done-action-confirmation')).getByText('Cancel'));
      expect(screen.queryByTestId('done-action-confirmation')).toBeNull();
      expect(cb.onAction).not.toHaveBeenCalled();
      await user.click(mainButton() as HTMLElement);
      await user.click(screen.getByTestId('confirm-finish-action'));
      await waitFor(() => expect(cb.onAction).toHaveBeenCalledWith('complete_action', undefined, ''));
    });

    it('needs a reason to Dismiss', async () => {
      const user = userEvent.setup();
      const cb = renderGlob(action());
      await user.click(screen.getByTestId('more-actions'));
      await user.click(screen.getByTestId('more-dismiss_action'));
      const confirm = within(screen.getByTestId('dismiss-action-confirmation'));
      expect((confirm.getByTestId<HTMLButtonElement>('confirm-finish-action')).disabled).toBe(true);
      await user.type(confirm.getByTestId('action-note'), 'no longer needed');
      await user.click(confirm.getByTestId('confirm-finish-action'));
      await waitFor(() => expect(cb.onAction).toHaveBeenCalledWith('dismiss_action', undefined, 'no longer needed'));
    });

    it('shows who is meant to do it, then who finished it and what they noted', () => {
      renderGlob(action({ attributes: { assignee: 'sam@example.com', outcome: null } }));
      expect(screen.getByTestId('action-assignee').textContent).toContain('sam@example.com');
      cleanup();
      renderGlob(
        action({
          status: 'signed_off',
          allowedActions: ['delete'],
          attributes: { assignee: null, outcome: { kind: 'done', by: 'lee@example.com', at: '2026-10-15T10:00:00.000Z', note: 'all green' } },
        }),
      );
      expect(screen.getByTestId('action-outcome').textContent).toContain('lee@example.com');
      expect(screen.getByTestId('action-outcome').textContent).toContain('all green');
      expect(mainButton()).toBeNull();
    });

    it('hides the code-work sections: labels, size, deploys and tests', () => {
      renderGlob(action());
      for (const name of ['labels', 'size', 'deploys', 'tests']) {
        expect(document.querySelector(`[data-section="${name}"]`)?.textContent ?? '').toBe('');
      }
    });
  });
});
