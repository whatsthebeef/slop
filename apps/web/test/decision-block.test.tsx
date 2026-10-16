// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Action, DecisionAttributes, DecisionLearning, EffectCheck, KbSignal, KbTarget } from '@slop/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EffectCheckView, SignalFigures } from '../src/components/decision-learning';
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

const renderGlob = (glob: GlobView, role: BoardView['role'] = 'admin', decide?: () => Promise<boolean>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDecide = vi.fn(decide ?? (() => Promise.resolve(true)));
  const tree = (shown: GlobView) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobDetail
          board={board(role)}
          glob={shown}
          initialArtifact={null}
          onClose={vi.fn()}
          onUpdate={vi.fn(() => Promise.resolve(null))}
          onReload={vi.fn(() => Promise.resolve())}
          onAction={vi.fn(() => Promise.resolve(true))}
          onReviewLabel={vi.fn()}
          onDismissEdge={vi.fn(() => Promise.resolve(true))}
          onAddRelation={vi.fn(() => Promise.resolve(true))}
          onAnswerQuestion={vi.fn(() => Promise.resolve(true))}
          onDismissQuestion={vi.fn(() => Promise.resolve(true))}
          onDecide={onDecide}
          onDelete={vi.fn(() => Promise.resolve())}
          onAddStep={vi.fn(() => Promise.resolve(true))}
          onCompleteStep={vi.fn(() => Promise.resolve(true))}
          onDismissStep={vi.fn(() => Promise.resolve(true))}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(glob));
  return { onDecide, moveTo: (next: GlobView) => view.rerender(tree(next)) };
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
  await user.click(await screen.findByTestId('more-outcomes'));
  return screen.findByTestId('outcomes-menu');
};

/** The outcome controls at the foot of the decision block, where a learning's outcome lives (the action row has none). */
const actionRow = () => screen.findByTestId('outcomes');

/** The outcome block's main button, whatever outcome it is for now. */
const mainOutcome = async (): Promise<HTMLButtonElement> => {
  const group = await within(await screen.findByTestId('outcomes')).findByRole('group');
  const button = group.querySelector('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('the outcome block has a main button');
  return button;
};

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
  it('reads why, then the change named by its target, then the recommendation and where it came from, above the action row', async () => {
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
    follows(why, row);
    follows(why, heading);
    follows(heading, recommendation);
    follows(recommendation, source);
    expect(screen.queryByText('Decide')).toBeNull();
    expect(screen.queryByText('What approving changes')).toBeNull();
    // The evidence is under the plain Evidence and history label, not beside the why, and nothing in it is a collapsible.
    const history = screen.getByTestId('evidence-history');
    expect(within(history).getByTestId('evidence-summary').textContent).toBe('Seen 3 times on 2 globs: s1t1, s1t2');
    expect(history.tagName).not.toBe('DETAILS');
    expect(history.querySelector('details')).toBeNull();
    expect(within(why).queryByTestId('evidence-summary')).toBeNull();
  });

  it('makes the recommended outcome the decision block’s main button, with the other outcomes in its ▾, and no primary or ▾ in the action row', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ draft: { section: null, content: 'The draft' } }));
    vi.spyOn(api, 'suggestion').mockResolvedValue(suggestionOf('approve'));
    renderGlob(decision());
    const outcomes = await actionRow();
    expect((await mainOutcome()).textContent).toBe('Approve change');
    expect(screen.getAllByRole('button', { name: 'Approve change' })).toHaveLength(1);
    expect(within(screen.getByTestId('proposal-block')).getByTestId('outcomes')).toBe(outcomes);
    expect(screen.queryByTestId('main-action')).toBeNull();
    expect(screen.queryByTestId('more-actions')).toBeNull();
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

  it('shows nothing for a recommendation the rules made: no Leaning text, waiting line or empty assessment', async () => {
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
    await actionRow();
    expect(screen.queryByTestId('suggestion')).toBeNull();
    expect(screen.queryByText(/Leaning/)).toBeNull();
  });

  it('shows no waiting text while the recommendation runs, and keeps Approve enabled', async () => {
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ draft: { section: null, content: 'The draft' } }));
    vi.spyOn(api, 'suggestion').mockResolvedValue({ ...suggestionOf('approve'), suggestion: null, pending: true });
    renderGlob(decision());
    await actionRow();
    expect((await mainOutcome()).disabled).toBe(false);
    expect(screen.queryByText(/Getting a recommendation/)).toBeNull();
    expect(screen.queryByTestId('suggest-working')).toBeNull();
    expect(screen.queryByTestId('suggestion')).toBeNull();
  });

  it('offers only Pick up before anyone has picked the learning up', async () => {
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ draft: { section: null, content: 'The draft' } }));
    renderGlob({ ...decision(), status: 'planning', list: 'planning', allowedActions: ['pick_up', 'delete'] satisfies Action[] });
    const row = await screen.findByTestId('glob-actions');
    expect((await within(row).findByTestId('main-action')).textContent).toMatch(/Pick up/);
    expect(screen.getByTestId('decision-block')).toBeTruthy();
    expect(screen.queryByTestId('outcomes')).toBeNull();
    expect(screen.queryByText('Approve change')).toBeNull();
    expect(screen.queryByTestId('outcome-reject')).toBeNull();
  });

  it('shows no outcome buttons for a learning that is already decided, and the action row has no second place to act', async () => {
    vi.spyOn(api, 'globDiff').mockResolvedValue(diffOf({ learning: { ...openLearning, status: 'approved' } }));
    renderGlob(decision());
    await screen.findByTestId('decision-block');
    await waitFor(() => expect(screen.queryByTestId('outcomes')).toBeNull());
    expect(screen.queryByTestId('outcome-accept')).toBeNull();
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
    for (const name of ['plan', 'artifacts', 'deploys', 'tests', 'findings', 'size']) {
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
    expect(within(row).getByTestId('outcome-form-accept_with_edits')).toBe(form);
    expect(within(form).getByRole('textbox')).toHaveProperty('value', 'The recommended wording');
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    expect(within(row).getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByTestId('glob-actions')).toBeNull();
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
    expect([...select.options].map((o) => o.textContent)).toEqual(['Other…', "Don't check"]);
    expect(screen.getByText(/Check it worked \(optional\)/)).toBeTruthy();
    expect(screen.getByText(/slop flags it/)).toBeTruthy();
  });

  describe('with a recommended check (s15t201)', () => {
    const sig = (key: string, label: string, affected = 9, eligible = 45): KbSignal => ({ ...signal, key, label, figures: { affected, eligible, rate: affected / eligible, count: affected } });
    const measured = [
      sig('failure:no progress', 'no progress for 2 hours'),
      sig('finding:major', 'major review findings', 2, 8),
      sig('finding:minor', 'minor review findings', 1, 8),
      sig('finding:nit', 'nit review findings', 1, 8),
      sig('plan_amended', 'plans amended after review', 3, 10),
      sig('tester_loops', 'tester failing the first attempt', 4, 10),
    ];
    const recommending = () => {
      vi.spyOn(api, 'boardSignals').mockResolvedValue(measured);
      const stored = suggestionOf('approve');
      if (stored.suggestion === null) throw new Error('a suggestion');
      vi.spyOn(api, 'suggestion').mockResolvedValue({
        ...stored,
        suggestion: { ...stored.suggestion, suggestion: { ...stored.suggestion.suggestion, check: { signalKey: 'failure:no progress', reason: 'Runs failing with "no progress" should drop.' } } },
      });
    };

    it('pre-selects it with its reason, shows at most three signals plus Other and Don\'t check, in plain words', async () => {
      recommending();
      const user = userEvent.setup();
      renderGlob(decision({ evidenceCount: 2 }));
      const outcomes = await actionRow();
      await user.click(await within(outcomes).findByRole('button', { name: 'Approve change' }));
      const select = await screen.findByTestId('watch-signal');
      if (!(select instanceof HTMLSelectElement)) throw new Error('the watch step is a select');
      await waitFor(() => expect(select.value).toBe('failure:no progress'));
      const labels = [...select.options].map((o) => o.textContent);
      expect(labels[0]).toBe('no progress for 2 hours: 9 of 45 runs (20%) in the last 4 weeks (recommended)');
      expect(labels.slice(-2)).toEqual(['Other…', "Don't check"]);
      expect(labels.length).toBeLessThanOrEqual(5);
      expect(labels.join()).not.toMatch(/\d+\/\d+/);
      expect((await screen.findByTestId('watch-reason')).textContent).toBe('Runs failing with "no progress" should drop.');
    });

    it('sends the recommended check on approval, and nothing once Don\'t check is chosen', async () => {
      recommending();
      const user = userEvent.setup();
      const { onDecide } = renderGlob(decision());
      const outcomes = await actionRow();
      await user.click(await within(outcomes).findByRole('button', { name: 'Approve change' }));
      const select = await screen.findByTestId('watch-signal');
      await waitFor(() => expect(select).toHaveProperty('value', 'failure:no progress'));
      await user.click(screen.getByTestId('accept-confirm'));
      expect(onDecide).toHaveBeenLastCalledWith({ outcome: 'accept', watchSignal: 'failure:no progress' });
    });

    it('opens the whole list, searchable, from Other…', async () => {
      recommending();
      const user = userEvent.setup();
      renderGlob(decision());
      const outcomes = await actionRow();
      await user.click(await within(outcomes).findByRole('button', { name: 'Approve change' }));
      const select = await screen.findByTestId('watch-signal');
      await waitFor(() => expect(select).toHaveProperty('value', 'failure:no progress'));
      await user.selectOptions(select, 'Other…');
      const list = await screen.findByTestId('watch-list');
      if (!(list instanceof HTMLSelectElement)) throw new Error('the list is a select');
      expect(list.options).toHaveLength(measured.length);
      await user.type(screen.getByTestId('watch-search'), 'tester');
      expect([...list.options].map((o) => o.value)).toEqual(['tester_loops']);
      await user.selectOptions(list, 'tester_loops');
      expect(screen.queryByTestId('watch-all')).toBeNull();
      expect(screen.getByTestId('watch-signal')).toHaveProperty('value', 'tester_loops');
    });
  });

  it('sends nothing to watch by default', async () => {
    const user = userEvent.setup();
    const { onDecide } = renderGlob(decision());
    const outcomes = await actionRow();
    await user.click(within(outcomes).getByRole('button', { name: 'Approve change' }));
    expect(await mainOutcome()).toHaveProperty('disabled', true);
    expect(screen.getByTestId('accept-confirm-text').textContent).toBe('Applies the change to its target, then moves this decision to Reviewing.');
    await user.click(screen.getByTestId('accept-confirm'));
    expect(onDecide).toHaveBeenCalledWith({ outcome: 'accept' });
  });

  it('confirms a hotspot\'s refactor glob in its own form, with its own text, and creates it on Create', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'plan').mockResolvedValue({
      current: { content: 'Refactor the file.', version: 1, provenance: { actor: 'slop', by: 'sessionator' }, createdAt: '2026-10-08T00:00:00Z' },
      versions: [{ version: 1 }],
    } as unknown as Awaited<ReturnType<typeof api.plan>>);
    const { onDecide } = renderGlob(decision({ origin: { kind: 'hotspot', path: 'src/a.ts' }, channel: 'mined' }));
    await user.click(await screen.findByRole('button', { name: 'Create refactor glob' }));
    const text = (await screen.findByTestId('accept-confirm-text')).textContent;
    expect(text).toContain('Creates a refactor glob from this proposal (Tests live next to the code they cover)');
    expect(text).not.toContain('no knowledge change');
    expect(onDecide).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('accept-confirm'));
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

describe('plain figures (s15t201)', () => {
  it('reads a mined learning\'s signal as one plain line, with no slash figures', () => {
    render(<SignalFigures signal={{ ...signal, key: 'failure:no progress', label: 'no progress for 2 hours', figures: { affected: 9, eligible: 45, rate: 0.2, count: 9 } }} />);
    const line = screen.getByTestId('signal').textContent;
    expect(line).toContain('no progress for 2 hours: 9 of 45 runs (20%) in the last 4 weeks');
    expect(line).not.toMatch(/\d+\/\d+/);
  });

  it('reads an effect check\'s before and after figures as "a of b globs (x%)"', () => {
    const figures = (affected: number, eligible: number, rate: number) => ({ affected, eligible, rate, globIds: [], affectedGlobIds: [] });
    const check: EffectCheck = {
      state: 'improved',
      key: 'failure:no progress',
      label: 'no progress for 2 hours',
      basis: { kind: 'time', since: '2026-10-07T00:00:00Z' },
      n: 10,
      before: figures(3, 10, 0.3),
      after: figures(1, 10, 0.1),
      worse: [],
      raisedItemId: null,
      checkedAt: null,
    };
    render(
      <MemoryRouter>
        <EffectCheckView boardId={1} check={check} />
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId('effect-figure').map((c) => c.textContent)).toEqual(['3 of 10 globs (30%)', '1 of 10 globs (10%)']);
  });
});

describe('a pressed outcome stays pending until the glob moves (s15b139)', () => {
  const reject = async (user: ReturnType<typeof userEvent.setup>) => {
    const menu = await openMenu(user);
    await user.click(within(menu).getByTestId('outcome-reject'));
    await user.type(await screen.findByLabelText('Reason (required)'), 'Not a rule');
    return mainOutcome();
  };

  it('disables the controls with a working label at once, sends one request however often it is pressed, and stays pending until the version changes', async () => {
    const user = userEvent.setup();
    const glob = decision();
    const { onDecide, moveTo } = renderGlob(glob);
    const main = await reject(user);
    await user.dblClick(main);
    expect(onDecide).toHaveBeenCalledTimes(1);
    await waitFor(async () => expect((await mainOutcome()).textContent).toContain('Rejecting…'));
    expect(await mainOutcome()).toHaveProperty('disabled', true);
    expect(screen.getByTestId('more-outcomes')).toHaveProperty('disabled', true);
    // The request has returned but the glob has not moved: still pending, and a click sends nothing.
    await user.click(await mainOutcome());
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('more-outcomes')).toHaveProperty('disabled', true);
    moveTo({ ...glob, version: glob.version + 1 });
    await waitFor(() => expect(screen.getByTestId('more-outcomes')).toHaveProperty('disabled', false));
  });

  it('re-enables the controls when the request fails', async () => {
    const user = userEvent.setup();
    const { onDecide } = renderGlob(decision(), 'admin', () => Promise.resolve(false));
    const main = await reject(user);
    await user.click(main);
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('more-outcomes')).toHaveProperty('disabled', false));
    expect((await mainOutcome()).textContent).not.toContain('Rejecting…');
  });

  it('holds a recommended outcome\'s Save the same way', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'suggestion').mockResolvedValue(suggestionOf('approve_with_edit', 'Better wording'));
    const glob = decision();
    const { onDecide } = renderGlob(glob);
    await user.click(await mainOutcome());
    await waitFor(async () => expect((await mainOutcome()).textContent).toMatch(/^Save/));
    await user.click(await mainOutcome());
    await waitFor(async () => expect((await mainOutcome()).textContent).toContain('Approving…'));
    await user.click(await mainOutcome());
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('more-outcomes')).toHaveProperty('disabled', true);
  });

  it('holds Keep as learning pending while it is sent, and frees the controls when it fails', async () => {
    const user = userEvent.setup();
    let fail: (e: Error) => void = () => undefined;
    vi.spyOn(api, 'keepAsLearning').mockImplementation(() => new Promise((_, reject) => (fail = reject)));
    renderGlob(decision());
    const menu = await openMenu(user);
    await user.click(within(menu).getByText('Approve without changing a document'));
    await user.click(await screen.findByTestId('keep-submit'));
    await waitFor(() => expect(screen.getByTestId('more-outcomes')).toHaveProperty('disabled', true));
    expect(await mainOutcome()).toHaveProperty('disabled', true);
    fail(new Error('nope'));
    await waitFor(() => expect(screen.getByTestId('more-outcomes')).toHaveProperty('disabled', false));
  });
});
