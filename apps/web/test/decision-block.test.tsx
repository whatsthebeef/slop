// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Action, DecisionAttributes, DecisionLearning, KbSignal, KbTarget } from '@slop/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobDetail } from '../src/components/glob-dialog';
import { api } from '../src/lib/api';
import type { BoardView, GlobDiff, GlobView } from '../src/lib/api';
import { board as coreBoard, glob as coreGlob } from '../../../packages/core/test/fixtures';

const board = (role: BoardView['role']): BoardView => ({ ...coreBoard, role });

const attributes = (patch: Partial<DecisionAttributes> = {}): DecisionAttributes => ({
  scope: { kind: 'project', ref: null },
  origin: { kind: 'submitted' },
  channel: 'agent',
  outcome: null,
  ...patch,
});

const decision = (patch: Partial<DecisionAttributes> = {}): GlobView => ({
  ...coreGlob(),
  title: 'Tests live next to the code they cover',
  category: 'decision',
  status: 'in_progress',
  list: 'doing',
  branch: '',
  pr: null,
  currentRun: null,
  allowedActions: ['decide'] satisfies Action[],
  attributes: attributes(patch),
});

const openLearning: DecisionLearning = {
  status: 'open',
  processing: 'drafted',
  processingError: null,
  processingAttempts: 0,
  processAfter: null,
  effectCheck: null,
};

const diffOf = (patch: Partial<GlobDiff> = {}): GlobDiff => ({
  target: null,
  currentVersion: null,
  preview: null,
  draft: null,
  learning: openLearning,
  ...patch,
});

const mergePolicy: KbTarget = { kind: 'merge_policy', name: 'merge_policy', section: null, newDocument: null };

const signal: KbSignal = {
  key: 'failure',
  kind: 'failure',
  agent: null,
  label: 'Run failures',
  window: { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z' },
  figures: { affected: 2, eligible: 10, rate: 0.2, count: 2 },
  globIds: [],
  examples: [],
  measuredAt: '2026-10-08T00:00:00Z',
};

const renderGlob = (glob: GlobView, role: BoardView['role'] = 'admin') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDecide = vi.fn(() => Promise.resolve(true));
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobDetail
          board={board(role)}
          glob={glob}
          initialArtifact={null}
          onClose={vi.fn()}
          onUpdate={vi.fn(() => Promise.resolve(null))}
          onReload={vi.fn(() => Promise.resolve())}
          onAction={vi.fn(() => Promise.resolve(true))}
          onReviewLabel={vi.fn()}
          onDismissEdge={vi.fn(() => Promise.resolve(true))}
          onAddRelation={vi.fn(() => Promise.resolve(true))}
          onDismiss={vi.fn(() => Promise.resolve(true))}
          onDecide={onDecide}
          onDelete={vi.fn(() => Promise.resolve())}
          onAddStep={vi.fn(() => Promise.resolve(true))}
          onCompleteStep={vi.fn(() => Promise.resolve(true))}
          onDismissStep={vi.fn(() => Promise.resolve(true))}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onDecide };
};

/** Adds an Element method jsdom lacks, leaving any real one in place. */
const polyfill = (name: string, value: () => unknown) => {
  if (!(name in Element.prototype)) {
    Object.defineProperty(Element.prototype, name, { value, configurable: true, writable: true });
  }
};

beforeAll(() => {
  polyfill('scrollIntoView', () => undefined);
  polyfill('hasPointerCapture', () => false);
  polyfill('setPointerCapture', () => undefined);
  polyfill('releasePointerCapture', () => undefined);
});

beforeEach(() => {
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
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no server in component tests'))));
  vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf());
  vi.spyOn(api, 'boardSignals').mockResolvedValue([]);
  vi.spyOn(api, 'suggestion').mockResolvedValue({ suggestion: null, pending: false, stale: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByTestId('more-outcomes'));
  return screen.findByTestId('outcomes-menu');
};

describe('the proposal block of a learning', () => {
  it('reads statement, then what approving changes, then the controls, with no Decide heading', async () => {
    renderGlob(decision());
    const statement = await screen.findByTestId('proposal-statement');
    const changes = await screen.findByText('What approving changes');
    const outcomes = await screen.findByTestId('outcomes');
    expect(statement.textContent).toBe('Tests live next to the code they cover');
    expect(statement.compareDocumentPosition(changes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(changes.compareDocumentPosition(outcomes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('Decide')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decide' })).toBeNull();
    // The block's controls live inside the same block as the statement.
    expect(within(screen.getByTestId('proposal-block')).getByTestId('outcomes')).toBe(outcomes);
  });

  it('says only a person can approve a merge policy, and names what is approved', async () => {
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ target: mergePolicy }));
    renderGlob(decision());
    const notice = await screen.findByTestId('person-only-notice');
    expect(notice.textContent).toBe('Only a person can approve this kind of change');
    expect(within(await screen.findByTestId('outcomes')).getByRole('button', { name: 'Approve merge policy' })).toBeTruthy();
  });

  it('has no notice for an ordinary section change', async () => {
    renderGlob(decision());
    await screen.findByTestId('outcomes');
    expect(screen.queryByTestId('person-only-notice')).toBeNull();
  });

  it('shows the conflict note beside the controls and again with the reject reason', async () => {
    const user = userEvent.setup();
    renderGlob(decision({ conflictsWith: ['s1f9'] }));
    expect((await screen.findByTestId('conflict-note')).textContent).toContain('broader-scope');
    expect(screen.queryByTestId('conflict-note-reject')).toBeNull();
    const menu = await openMenu(user);
    await user.click(within(menu).getByTestId('outcome-reject'));
    expect(await screen.findByTestId('conflict-note-reject')).toBeTruthy();
    expect(screen.getByLabelText('Reason (required)')).toBeTruthy();
  });

  it('opens the statement form in the block from the menu, with no standalone Keep button', async () => {
    const user = userEvent.setup();
    renderGlob(decision());
    await screen.findByTestId('outcomes');
    expect(screen.queryByTestId('keep-as-learning')).toBeNull();
    expect(screen.queryByTestId('keep-form')).toBeNull();
    const menu = await openMenu(user);
    expect(within(menu).getByText('Store it as an approved learning agents are given, without editing a document')).toBeTruthy();
    await user.click(within(menu).getByText('Approve without changing a document'));
    const form = await screen.findByTestId('keep-form');
    expect(within(screen.getByTestId('outcomes')).getByTestId('keep-form')).toBe(form);
    expect(within(form).getByRole('textbox')).toHaveProperty('value', 'Tests live next to the code they cover');
  });

  it('offers keeping only to an admin on an open statement', async () => {
    const user = userEvent.setup();
    renderGlob(decision(), 'po');
    const menu = await openMenu(user);
    expect(within(menu).queryByText('Approve without changing a document')).toBeNull();
    expect(within(menu).getByText('Reject…')).toBeTruthy();
  });
});

describe('the admin-only check on both accept modes', () => {
  it('blocks a PO submitting Accept with edits on an admin-only target, as it blocks Approve', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ target: mergePolicy, draft: { content: '{}' } as GlobDiff['draft'] }));
    vi.spyOn(api, 'suggestion').mockResolvedValue({
      suggestion: {
        suggestion: { action: 'approve_with_edit', editedDraft: '{"edited":true}', mergeInto: null, mergedText: null, reason: 'tighter' },
        model: 'm',
        at: '2026-10-08T00:00:00Z',
        stamp: { draftVersion: 1, targetVersion: 1, promptVersion: 1 },
      },
      pending: false,
      stale: false,
      error: null,
    });
    const { onDecide } = renderGlob(decision(), 'po');
    const outcomes = await screen.findByTestId('outcomes');
    expect(within(outcomes).getByRole('group', { name: 'Outcome' })).toBeTruthy();
    await user.click(await screen.findByTestId('apply-suggestion'));
    const submit = await screen.findByRole('button', { name: /Accept with edits|Approve with edits|with edits/i });
    expect(await screen.findByTestId('outcome-form-accept_with_edits')).toBeTruthy();
    expect(submit).toHaveProperty('disabled', true);
    await user.click(submit);
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe('the watch signal step', () => {
  it('is absent until Approve change is chosen, then defaults to not watching', async () => {
    const user = userEvent.setup();
    renderGlob(decision());
    const outcomes = await screen.findByTestId('outcomes');
    expect(screen.queryByTestId('watch-signal')).toBeNull();
    await user.click(within(outcomes).getByRole('button', { name: 'Approve change' }));
    const select = await screen.findByTestId('watch-signal');
    if (!(select instanceof HTMLSelectElement)) throw new Error('the watch step is a select');
    expect(select.value).toBe('');
    expect(select.options[0]?.textContent).toBe("Don't watch");
    expect(screen.getByText(/Check it worked \(optional\): watch/)).toBeTruthy();
    expect(screen.getByText(/slop flags it/)).toBeTruthy();
  });

  it('sends nothing to watch by default', async () => {
    const user = userEvent.setup();
    const { onDecide } = renderGlob(decision());
    const outcomes = await screen.findByTestId('outcomes');
    await user.click(within(outcomes).getByRole('button', { name: 'Approve change' }));
    await user.click(within(outcomes).getByRole('button', { name: 'Approve change' }));
    expect(onDecide).toHaveBeenCalledWith({ outcome: 'accept' });
  });

  it('names the signal an item already has instead of offering a choice', async () => {
    const user = userEvent.setup();
    renderGlob(decision({ signal, origin: { kind: 'mined' } }));
    const outcomes = await screen.findByTestId('outcomes');
    await user.click(within(outcomes).getByRole('button', { name: 'Approve change' }));
    const line = await screen.findByTestId('watch-own');
    expect(line.textContent).toContain('Run failures');
    expect(screen.queryByTestId('watch-signal')).toBeNull();
  });

  it('is not offered for a whole document', async () => {
    const user = userEvent.setup();
    renderGlob(decision({ document: { name: 'conventions', area: 'code', audience: [], description: 'How we write code' } }));
    const outcomes = await screen.findByTestId('outcomes');
    await user.click(within(outcomes).getByRole('button', { name: 'Approve document' }));
    expect(await screen.findByTestId('outcome-form-accept')).toBeTruthy();
    expect(screen.queryByTestId('watch-signal')).toBeNull();
    expect(screen.queryByTestId('watch-own')).toBeNull();
  });
});
