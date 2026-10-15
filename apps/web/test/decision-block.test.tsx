// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Action, DecisionAttributes, DecisionLearning, KbSignal, KbTarget } from '@slop/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobDetail } from '../src/components/glob-dialog';
import { api } from '../src/lib/api';
import type { BoardView, GlobDiff, GlobView } from '../src/lib/api';
import { scopeLabel } from '@slop/core';
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

const planOf = (content: string): Awaited<ReturnType<typeof api.plan>> =>
  ({ current: { content, version: 1 }, versions: [{ version: 1 }] }) as unknown as Awaited<ReturnType<typeof api.plan>>;

const suggestionOf = (action: 'approve' | 'approve_with_edit' | 'reject', editedDraft: string | null = null): Awaited<ReturnType<typeof api.suggestion>> => ({
  suggestion: {
    suggestion: { action, editedDraft, mergeInto: null, mergedText: null, reason: 'Fits the conventions.' },
    model: 'm',
    at: '2026-10-08T00:00:00Z',
    stamp: { draftVersion: 1, targetVersion: 1, promptVersion: 1 },
  },
  pending: false,
  stale: false,
  error: null,
});

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
  vi.spyOn(api, 'plan').mockResolvedValue(planOf(''));
  vi.spyOn(api, 'suggestion').mockResolvedValue({ suggestion: null, pending: false, stale: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByTestId('more-actions'));
  return screen.findByTestId('more-menu');
};

/** The action row under the title, where a learning's outcome lives. */
const actionRow = () => screen.findByTestId('glob-actions');

const DECIDING = /^(Approve|Reject|Save|Cancel|Waiting)/;

describe('the Decide block', () => {
  it('is a needs-a-person block of the shared family around the proposal, which keeps its own controls', async () => {
    renderGlob(decision());
    const block = await screen.findByTestId('decision-block');
    expect(block.getAttribute('data-block')).toBe('person');
    expect(block.querySelector('[data-testid="block-head"]')?.textContent).toBe('Decision needed');
    expect(block.querySelector('[data-testid="block-body"] [data-testid="proposal-block"]')).not.toBeNull();
  });
});

describe('the proposal block of a learning', () => {
  it('reads why, then the change named by its target, then the recommendation and where it came from, under the action row', async () => {
    vi.spyOn(api, 'plan').mockResolvedValue(planOf('Tests next to the code keep them found and kept up to date.'));
    vi.spyOn(api, 'globDiff').mockResolvedValue(
      diffOf({
        target: { kind: 'doc', name: 'architecture', section: 'apps/web', newDocument: null },
        preview: { version: 1, stale: false, diff: [{ op: 'added', text: 'Tests live next to the code.' }], duplicateSections: [] },
      }),
    );
    vi.spyOn(api, 'suggestion').mockResolvedValue(suggestionOf('approve'));
    renderGlob(decision({ evidenceCount: 3, sourceGlobs: ['s1t1', 's1t2'] }));
    const row = await actionRow();
    const why = await screen.findByTestId('why');
    const heading = await screen.findByTestId('change-heading');
    const recommendation = await screen.findByTestId('recommendation');
    const source = await screen.findByTestId('decision-source');
    expect(await within(why).findByText(/keep them found/)).toBeTruthy();
    expect(heading.textContent).toBe('Addition to architecture › apps/web');
    const follows = (a: Element, b: Element) => expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    follows(row, why);
    follows(why, heading);
    follows(heading, recommendation);
    follows(recommendation, source);
    expect(screen.queryByText('Decide')).toBeNull();
    expect(screen.queryByText('What approving changes')).toBeNull();
    // The evidence is behind the collapsed Evidence and history, not beside the why.
    const history = screen.getByTestId('evidence-history');
    expect(within(history).getByTestId('evidence-summary').textContent).toBe('Seen 3 times on 2 globs: s1t1, s1t2');
    expect(history.hasAttribute('open')).toBe(false);
    expect(within(why).queryByTestId('evidence-summary')).toBeNull();
  });

  it('makes the recommended outcome the action row’s main button, with the other outcomes in its ▾, and no buttons that decide in the body', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ draft: { section: null, content: 'The draft' } }));
    vi.spyOn(api, 'suggestion').mockResolvedValue(suggestionOf('approve'));
    renderGlob(decision());
    const row = await actionRow();
    expect((await within(row).findByTestId('main-action')).textContent).toBe('Approve change');
    expect(screen.getAllByRole('button', { name: 'Approve change' })).toHaveLength(1);
    const body = screen.getByTestId('proposal-block');
    expect(within(body).queryByRole('button', { name: DECIDING })).toBeNull();
    expect(screen.queryByTestId('outcomes')).toBeNull();
    const menu = await openMenu(user);
    expect(within(menu).getByText('Reject…')).toBeTruthy();
    expect(within(menu).getByText('Approve with edits…')).toBeTruthy();
    expect(within(menu).getByText('Approve without changing a document')).toBeTruthy();
    expect(within(menu).getByText('Get a new recommendation')).toBeTruthy();
    expect(screen.queryByTestId('apply-suggestion')).toBeNull();
  });

  it('shows the recommendation once, as one line', async () => {
    vi.spyOn(api, 'suggestion').mockResolvedValue(suggestionOf('approve'));
    renderGlob(decision());
    const recommendation = await screen.findByTestId('recommendation');
    expect((await within(recommendation).findByTestId('suggestion')).textContent).toBe('Recommends: Approve as drafted. Fits the conventions.');
    expect(screen.getAllByTestId('recommendation')).toHaveLength(1);
    expect(screen.queryByTestId('assessment')).toBeNull();
  });

  it('reads a recommendation the rules made as a leaning, waiting for the draft until there is one', async () => {
    vi.spyOn(api, 'suggestion').mockResolvedValue({
      ...suggestionOf('approve'),
      suggestion: {
        suggestion: { action: 'approve', editedDraft: null, mergeInto: null, mergedText: null, reason: 'Judged on the statement alone.' },
        model: 'rules',
        at: '2026-10-08T00:00:00Z',
        stamp: { draftVersion: null, targetVersion: null, promptVersion: 1 },
      },
    });
    renderGlob(decision());
    expect((await screen.findByTestId('suggestion')).textContent).toBe('Leaning: Approve as drafted, waiting for the draft. Judged on the statement alone.');
  });

  it('does not repeat the title as a heading, show the raw assessment fields or the boilerplate', async () => {
    vi.spyOn(api, 'plan').mockResolvedValue(planOf('The full statement of the learning.'));
    renderGlob(decision());
    await screen.findByText('The full statement of the learning.');
    await actionRow();
    expect(screen.queryByTestId('proposal-statement')).toBeNull();
    expect(screen.queryByText(/never deleted/)).toBeNull();
    expect(screen.queryByTestId('person-only-notice')).toBeNull();
    expect(screen.queryByText('Scope')).toBeNull();
    expect(screen.queryByText(/^Channel/)).toBeNull();
    expect(screen.queryByText('Delete…')).toBeNull();
  });

  it('shows only the learning’s own sections, none of a work glob’s', async () => {
    renderGlob(decision());
    await actionRow();
    const page = screen.getByTestId('glob-page');
    for (const name of ['plan', 'artifacts', 'deploys', 'environments', 'tests', 'findings', 'size']) {
      expect(page.querySelector(`[data-section="${name}"]`)?.childElementCount ?? 0).toBe(0);
    }
    expect(page.querySelector('[data-section="decision"]')?.childElementCount).toBeGreaterThan(0);
  });

  it('says where it came from with the matching icon: an agent, a person, or the Matrix', async () => {
    for (const [channel, text, icon] of [
      ['agent', 'From an agent', 'machine'],
      ['human', 'From a person', 'human'],
      ['mined', 'The Matrix', 'the Matrix'],
    ] as const) {
      renderGlob(decision({ channel, ...(channel === 'mined' ? { origin: { kind: 'mined' } } : {}) }));
      const source = await screen.findByTestId('decision-source');
      expect(source.textContent).toBe(`Where it came from:${text}`);
      expect(source.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(screen.queryByText(/^via /)).toBeNull();
      expect(icon.length).toBeGreaterThan(0);
      cleanup();
    }
  });

  it('writes the scope in plain words, behind a change link', async () => {
    const user = userEvent.setup();
    renderGlob(decision({ scope: { kind: 'future_work', ref: null } }));
    const applies = await screen.findByTestId('applies-to');
    expect(within(applies).getByTestId('decision-scope').textContent).toBe('Applies to: All new globs');
    expect(screen.queryByTestId('scope-editor')).toBeNull();
    await user.click(within(applies).getByTestId('change-scope'));
    const kinds = within(await screen.findByTestId('scope-kind')).getAllByRole('option').map((o) => o.textContent);
    expect(kinds).toContain('This glob only');
    expect(kinds).toContain('The whole project (existing and new globs)');
  });

  it('labels each scope: this glob only, all new globs, new globs in a group, the whole project', () => {
    const scopes = [
      [{ kind: 'glob', ref: 's1t1' }, 'This glob only'],
      [{ kind: 'future_work', ref: null }, 'All new globs'],
      [{ kind: 'future_work', ref: 'web' }, 'New globs in group web'],
      [{ kind: 'project', ref: null }, 'The whole project (existing and new globs)'],
    ] as const;
    for (const [scope, text] of scopes) expect(scopeLabel(scope)).toBe(text);
  });

  it('hides the scope line for a change routed to a document', async () => {
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ target: { kind: 'doc', name: 'architecture', section: null, newDocument: null } }));
    renderGlob(decision());
    await actionRow();
    await waitFor(() => expect(screen.queryByTestId('applies-to')).toBeNull());
    expect(await screen.findByTestId('change-heading')).toBeTruthy();
    expect(screen.queryByTestId('applies-to')).toBeNull();
  });

  it('names a change by whether its section existed before', async () => {
    const target = { kind: 'doc', name: 'architecture', section: 'apps/web', newDocument: null } as const;
    const cases = [
      [{ diff: [{ op: 'added', text: 'x' }] as const, sectionExisted: false }, 'New section in architecture › apps/web'],
      [{ diff: [{ op: 'added', text: 'x' }] as const, sectionExisted: true }, 'Addition to architecture › apps/web'],
      [{ diff: [{ op: 'removed', text: 'a' }, { op: 'added', text: 'b' }] as const, sectionExisted: true }, 'Edit to architecture › apps/web'],
      [{ diff: [{ op: 'same', text: 'a' }] as const, sectionExisted: true }, 'No change to architecture › apps/web'],
    ] as const;
    for (const [{ diff, sectionExisted }, text] of cases) {
      vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ target, sectionExisted, preview: { version: 1, stale: false, diff: [...diff], duplicateSections: [] } }));
      renderGlob(decision());
      expect((await screen.findByTestId('change-heading')).textContent).toBe(text);
      cleanup();
    }
  });

  it('shows Waiting for the draft, disabled, with only Reject… in the ▾, while the change is being drafted', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ learning: { ...openLearning, processing: 'routed' } }));
    renderGlob(decision());
    const main = await screen.findByRole('button', { name: 'Waiting for the draft' });
    expect(main).toHaveProperty('disabled', true);
    const menu = await openMenu(user);
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent.startsWith('Reject…'))).toEqual([true]);
  });

  it('opens approve-with-edits in the body, pre-filled with the recommended wording, with a single Save and Cancel in the action row', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ draft: { section: null, content: 'The draft' } }));
    vi.spyOn(api, 'suggestion').mockResolvedValue(suggestionOf('approve_with_edit', 'The recommended wording'));
    renderGlob(decision());
    const row = await actionRow();
    await user.click(await within(row).findByRole('button', { name: 'Approve with edits…' }));
    const form = await screen.findByTestId('outcome-form-accept_with_edits');
    expect(within(screen.getByTestId('proposal-block')).getByTestId('outcome-forms')).toBeTruthy();
    expect(within(form).getByRole('textbox')).toHaveProperty('value', 'The recommended wording');
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    expect(within(row).getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(within(screen.getByTestId('proposal-block')).queryByRole('button', { name: DECIDING })).toBeNull();
    expect(screen.queryByTestId('apply-suggestion')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('outcome-form-accept_with_edits')).toBeNull();
  });

  it('opens approve-with-edits from the menu pre-filled with the draft without a recommendation', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ draft: { section: null, content: 'The draft' } }));
    renderGlob(decision());
    const menu = await openMenu(user);
    await user.click(within(menu).getByTestId('outcome-accept_with_edits'));
    const form = await screen.findByTestId('outcome-form-accept_with_edits');
    expect(within(form).getByRole('textbox')).toHaveProperty('value', 'The draft');
  });

  it('has no notice for an ordinary section change', async () => {
    renderGlob(decision());
    await actionRow();
    expect(screen.queryByTestId('person-only-notice')).toBeNull();
  });

  it('shows the conflict note beside the main button and again with the reject reason', async () => {
    const user = userEvent.setup();
    renderGlob(decision({ conflictsWith: ['s1f9'] }));
    expect((await screen.findByTestId('conflict-note')).textContent).toContain('broader-scope');
    expect(screen.queryByTestId('conflict-note-reject')).toBeNull();
    const menu = await openMenu(user);
    await user.click(within(menu).getByTestId('outcome-reject'));
    expect(await screen.findByTestId('conflict-note-reject')).toBeTruthy();
    expect(screen.getByLabelText('Reason (required)')).toBeTruthy();
  });

  it('opens the statement form in the body from the menu, with no standalone Keep button', async () => {
    const user = userEvent.setup();
    renderGlob(decision());
    await actionRow();
    expect(screen.queryByTestId('keep-as-learning')).toBeNull();
    expect(screen.queryByTestId('keep-form')).toBeNull();
    const menu = await openMenu(user);
    expect(within(menu).getByText('Store it as an approved learning agents are given, without editing a document')).toBeTruthy();
    await user.click(within(menu).getByText('Approve without changing a document'));
    const form = await screen.findByTestId('keep-form');
    expect(within(screen.getByTestId('outcome-forms')).getByTestId('keep-form')).toBe(form);
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
  it('blocks a PO approving with edits on an admin-only target, as it blocks Approve', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ target: mergePolicy, draft: { section: null, content: '{}' } }));
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
    const outcomes = await actionRow();
    const primary = await within(outcomes).findByRole('button', { name: 'Approve with edits…' });
    expect(primary).toHaveProperty('disabled', true);
    await user.click(primary);
    expect(screen.queryByTestId('outcome-form-accept_with_edits')).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe('a recommended reject on an admin-only target', () => {
  it('leaves a PO a usable primary Reject…', async () => {
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ target: mergePolicy }));
    vi.spyOn(api, 'suggestion').mockResolvedValue(suggestionOf('reject'));
    renderGlob(decision(), 'po');
    const outcomes = await actionRow();
    expect(await within(outcomes).findByRole('button', { name: 'Reject…' })).toHaveProperty('disabled', false);
  });
});

describe('the watch signal step', () => {
  it('is absent until Approve change is chosen, then defaults to not watching', async () => {
    const user = userEvent.setup();
    renderGlob(decision());
    const outcomes = await actionRow();
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
    const outcomes = await actionRow();
    await user.click(within(outcomes).getByRole('button', { name: 'Approve change' }));
    await user.click(within(outcomes).getByRole('button', { name: 'Approve change' }));
    expect(onDecide).toHaveBeenCalledWith({ outcome: 'accept' });
  });

  it('names the signal an item already has instead of offering a choice', async () => {
    const user = userEvent.setup();
    renderGlob(decision({ signal, origin: { kind: 'mined' } }));
    const outcomes = await actionRow();
    await user.click(within(outcomes).getByRole('button', { name: 'Approve change' }));
    const line = await screen.findByTestId('watch-own');
    expect(line.textContent).toContain('Run failures');
    expect(screen.queryByTestId('watch-signal')).toBeNull();
  });

  it('is not offered for a whole document', async () => {
    const user = userEvent.setup();
    renderGlob(decision({ document: { name: 'conventions', area: 'code', audience: [], description: 'How we write code' } }));
    const outcomes = await actionRow();
    await user.click(within(outcomes).getByRole('button', { name: 'Approve document' }));
    expect(await screen.findByTestId('outcome-form-accept')).toBeTruthy();
    expect(screen.queryByTestId('watch-signal')).toBeNull();
    expect(screen.queryByTestId('watch-own')).toBeNull();
  });
});
