// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { holdLine, relationTips } from '@slop/core';
import type { Holding, RelationsView, RelationSuggestion } from '@slop/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HumanSteps } from '../src/components/human-steps';
import { RelatedSection } from '../src/components/glob-view/related';
import type { SuggestionHandler } from '../src/components/glob-view/related';
import { RelationScanSpend } from '../src/pages/settings';
import type { AddRelationInput, BoardView, GlobView, ListedHumanStep } from '../src/lib/api';
import { relationScanLine, spendBreakdown } from '../src/lib/review-settings';
import { board as coreBoard, glob as coreGlob } from '../../../packages/core/test/fixtures';

vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api: {
    globs: vi.fn().mockResolvedValue([]),
    spend: vi.fn().mockResolvedValue({ usd: 2, unpricedCalls: 3, bySource: { chat: 1.9, relation_scan: 0.0123 }, unpricedBySource: { relation_scan: 2 } }),
  },
}));

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => undefined;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const board: BoardView = { ...coreBoard, role: 'dev' };
const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...coreGlob(), list: 'planning', branch: 's1t1', currentRun: null, ...patch });

const hold = (to: string, patch: Partial<Holding> = {}): Holding => ({
  relationId: `rel_${to}`,
  to,
  toTitle: `Title of ${to}`,
  toIsDecision: false,
  gate: 'start',
  until: 'merged',
  state: 'open',
  reason: null,
  source: 'person',
  ...patch,
});
const related = (patch: Partial<RelationsView> = {}): RelationsView => ({ holding: [], holdsBack: [], done: [], ...patch });

const renderRelated = (glob: GlobView, onSuggestion?: SuggestionHandler) => {
  const onDismissEdge = vi.fn(() => Promise.resolve(true));
  const onAddRelation = vi.fn<(input: AddRelationInput) => Promise<boolean>>(() => Promise.resolve(true));
  const ctx = { board, glob, groups: [], busy: false, onAction: vi.fn(), onUpdate: vi.fn(), onOpenSection: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RelatedSection ctx={ctx} onDismissEdge={onDismissEdge} onAddRelation={onAddRelation} {...(onSuggestion === undefined ? {} : { onSuggestion })} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onDismissEdge, onAddRelation };
};

describe('Related: reasons', () => {
  it('badges a person or agent relation with no reason, and no inferred, learned, split or mention one', () => {
    renderRelated(
      view({
        relations: related({
          holding: [
            hold('s1t2'),
            hold('s1t3', { source: 'agent' }),
            hold('s1t4', { source: 'inferred' }),
            hold('s1t5', { source: 'learned' }),
            hold('s1t6', { source: 'split' }),
            hold('s1t7', { source: 'mention' }),
            hold('s1t9', { source: 'auto' }),
            hold('s1t8', { reason: 'needs the schema' }),
          ],
        }),
      }),
    );
    expect(screen.getByTestId('no-reason-s1t2').textContent).toBe('no reason given');
    expect(screen.getByTestId('no-reason-s1t3')).not.toBeNull();
    for (const id of ['s1t4', 's1t5', 's1t6', 's1t7', 's1t8', 's1t9']) expect(screen.queryByTestId(`no-reason-${id}`)).toBeNull();
    expect(screen.getByTestId('related-row-s1t8').textContent).toContain(': needs the schema');
  });

  it('words an until of merged as merged and rolled out', () => {
    renderRelated(view({ relations: related({ holding: [hold('s1t2')] }) }));
    expect(screen.getByTestId('related-row-s1t2').textContent).toContain("can't start until merged and rolled out");
  });

  it('asks "Why does it wait? (one line)" and keeps the reason optional', async () => {
    const user = userEvent.setup();
    const { onAddRelation } = renderRelated(view({ relations: related() }));
    await user.click(screen.getByTestId('add-relation'));
    expect(screen.getByPlaceholderText('Why does it wait? (one line)')).not.toBeNull();
    await user.type(screen.getByLabelText('Glob or decision'), 's1t9');
    await user.click(screen.getByTestId('add-relation-submit'));
    expect(onAddRelation).toHaveBeenCalledWith({ gate: 'start', to: 's1t9', version: 1 });
  });

  it('adds a supersedes relation from the form, with its reason', async () => {
    const user = userEvent.setup();
    const { onAddRelation } = renderRelated(view({ relations: related() }));
    await user.click(screen.getByTestId('add-relation'));
    await user.selectOptions(screen.getByLabelText('Gate'), 'supersedes');
    await user.type(screen.getByLabelText('Glob or decision'), 's1t9');
    await user.type(screen.getByLabelText('Reason (optional)'), 'replaces it');
    await user.click(screen.getByTestId('add-relation-submit'));
    expect(onAddRelation).toHaveBeenCalledWith({ reason: 'replaces it', supersedes: 's1t9' });
  });
});

describe('Related: relations from a mention', () => {
  const sentence = 'Hand the profile over only after s1t7 is deployed.';

  it('shows a "from a mention" chip with the sentence as its hover, not inline, and a one-click dismiss', async () => {
    const user = userEvent.setup();
    const { onDismissEdge } = renderRelated(view({ relations: related({ holding: [hold('s1t7', { source: 'mention', reason: sentence })] }) }));
    const chip = screen.getByTestId('mention-badge-s1t7');
    expect(chip.textContent).toBe('from a mention');
    // The Tip describes the chip for screen readers (aria-describedby) and shows the sentence on hover.
    const describedBy = chip.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    expect(document.getElementById(describedBy)?.textContent).toBe(sentence);
    expect(screen.getByTestId('related-row-s1t7').textContent).not.toContain(`: ${sentence}`);
    await user.click(screen.getByTestId('dismiss-edge-s1t7'));
    expect(onDismissEdge).toHaveBeenCalledWith('rel_s1t7');
  });

  it('reads an old `auto` row the same way', () => {
    renderRelated(view({ relations: related({ holding: [hold('s1t7', { source: 'auto', reason: sentence })] }) }));
    expect(screen.getByTestId('mention-badge-s1t7').textContent).toBe('from a mention');
  });

  it('shows the sentence on hover after a pause', async () => {
    vi.useFakeTimers();
    try {
      renderRelated(view({ relations: related({ holding: [hold('s1t7', { source: 'mention', reason: sentence })] }) }));
      fireEvent.mouseEnter(screen.getByTestId('mention-badge-s1t7').parentElement as HTMLElement);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(sentence);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the inline reason for other sources', () => {
    renderRelated(view({ relations: related({ holding: [hold('s1t8', { source: 'person', reason: 'needs the schema' })] }) }));
    expect(screen.getByTestId('related-row-s1t8').textContent).toContain(': needs the schema');
    expect(screen.queryByTestId('mention-badge-s1t8')).toBeNull();
  });

  it('lists a relation that was forced through as overridden in Done', async () => {
    const user = userEvent.setup();
    renderRelated(
      view({ relations: related({ done: [{ relationId: 'rel_d', to: 's1t7', toTitle: 'T', gate: 'merge', until: 'merged', reason: sentence, source: 'mention', how: 'overridden' }] }) }),
    );
    await user.click(screen.getByTestId('related-toggle'));
    await user.click(screen.getByText('Done (1)'));
    expect(screen.getByTestId('related-row-s1t7').textContent).toContain('(forced through)');
  });
});

describe('Related: other boards', () => {
  it('names the other board for a visible glob and links into it', () => {
    renderRelated(view({ relations: related({ holding: [hold('s15t220', { external: { boardId: 15, boardName: 'Ops', hidden: false } })] }) }));
    const row = screen.getByTestId('related-row-s15t220');
    expect(within(row).getByTestId('related-board').textContent).toContain('board Ops');
    expect(within(row).getByRole('link').getAttribute('href')).toBe('/boards/15?glob=s15t220');
  });

  it('shows a hidden glob without its id or title', () => {
    renderRelated(
      view({ relations: related({ holding: [hold('another board', { toTitle: null, external: { boardId: 9, boardName: null, hidden: true } })] }) }),
    );
    const row = screen.getByTestId('related-row-another board');
    expect(within(row).getByTestId('related-hidden').textContent).toBe('Waits for a glob on another board');
    expect(within(row).queryByRole('link')).toBeNull();
  });

  it('says how many globs on other boards wait for this one', async () => {
    const user = userEvent.setup();
    renderRelated(view({ relations: related({ waitedOnByOtherBoards: 2 }) }));
    await user.click(screen.getByTestId('related-toggle'));
    expect(screen.getByTestId('related-other-boards').textContent).toBe('2 globs on other boards wait for this');
  });
});

describe('Related: supersedes', () => {
  it('shows "Superseded by" on the older glob with a dismiss that removes the label', async () => {
    const user = userEvent.setup();
    const { onDismissEdge } = renderRelated(
      view({ relations: related({ supersededBy: { id: 's1t9', title: 'Newer', reason: 'replaces it', source: 'agent', relationId: 'rel_sup' } }) }),
    );
    await user.click(screen.getByTestId('related-toggle'));
    const line = screen.getByTestId('related-superseded-by');
    expect(line.textContent).toContain('Superseded by s1t9');
    expect(line.textContent).toContain('replaces it');
    await user.click(within(line).getByTestId('dismiss-edge-s1t9'));
    expect(onDismissEdge).toHaveBeenCalledWith('rel_sup');
  });

  it('lists what the newer glob supersedes', async () => {
    const user = userEvent.setup();
    renderRelated(view({ relations: related({ supersedes: [{ id: 's1t3', title: 'Older', reason: 'obsolete', source: 'person' }] }) }));
    await user.click(screen.getByTestId('related-toggle'));
    expect(screen.getByTestId('related-supersedes-s1t3').textContent).toContain('Supersedes s1t3');
  });
});

describe('Related: a failed step still asks, a mention never does', () => {
  const failedStep = (patch: Partial<RelationSuggestion> = {}): RelationSuggestion => ({
    id: 'step:hs_1',
    kind: 'step_failed',
    text: 'This step failed: is there a fix glob?',
    mentioned: null,
    stepId: 'hs_1',
    ...patch,
  });

  it('has no Suggestions group: the failed step sits under "Failed step", with no mention question beside it', () => {
    renderRelated(view({ relations: related({ holding: [hold('s1t7', { source: 'mention', reason: 'only after s1t7' })] }), suggestions: [failedStep()] }), vi.fn());
    expect(screen.queryByText('Suggestions')).toBeNull();
    expect(screen.queryByTestId('related-suggestions')).toBeNull();
    expect(within(screen.getByTestId('related-failed-step')).getByText('Failed step')).not.toBeNull();
    expect(screen.queryByText(/is it a prerequisite/)).toBeNull();
    expect(screen.queryByText('Not a prerequisite')).toBeNull();
  });

  it('links a glob to a failed step: the accept carries the glob ID', async () => {
    const user = userEvent.setup();
    const onSuggestion = vi.fn<SuggestionHandler>(() => Promise.resolve(true));
    renderRelated(view({ relations: related(), suggestions: [failedStep()] }), onSuggestion);
    const link = screen.getByRole('button', { name: 'Link a glob' });
    expect((link as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Glob that fixes it'), 's1b6');
    await user.click(link);
    expect(onSuggestion).toHaveBeenCalledWith('step:hs_1', 'accept', 's1b6');
  });

  it('declines a failed step with "No fix needed"', async () => {
    const user = userEvent.setup();
    const onSuggestion = vi.fn<SuggestionHandler>(() => Promise.resolve(true));
    renderRelated(view({ relations: related(), suggestions: [failedStep()] }), onSuggestion);
    await user.click(screen.getByRole('button', { name: 'No fix needed' }));
    expect(onSuggestion).toHaveBeenCalledWith('step:hs_1', 'dismiss');
  });

  it('sends one request for a double click', async () => {
    const user = userEvent.setup();
    let finish: (ok: boolean) => void = () => undefined;
    const onSuggestion = vi.fn<SuggestionHandler>(() => new Promise<boolean>((resolve) => (finish = resolve)));
    renderRelated(view({ relations: related(), suggestions: [failedStep()] }), onSuggestion);
    await user.dblClick(screen.getByTestId('suggestion-dismiss'));
    expect(onSuggestion).toHaveBeenCalledTimes(1);
    finish(true);
  });

  it('shows the text without buttons when the page cannot answer', () => {
    renderRelated(view({ relations: related(), suggestions: [failedStep()] }));
    expect(screen.getByTestId('suggestion-step:hs_1').textContent).toContain('This step failed');
    expect(screen.queryByTestId('suggestion-accept')).toBeNull();
  });
});

describe('an older API without the new fields', () => {
  it('renders a plain relation with no badge-only fields, no suggestions and no supersedes', () => {
    renderRelated(view({ relations: related({ holding: [hold('s1t2', { source: 'inferred' })] }) }));
    expect(screen.getByTestId('related-row-s1t2')).not.toBeNull();
    expect(screen.queryByTestId('related-failed-step')).toBeNull();
    expect(screen.queryByTestId('related-superseded-by')).toBeNull();
    expect(screen.queryByTestId('related-other-boards')).toBeNull();
    expect(relationTips(view({ relations: related() }))).toEqual([]);
    expect(relationTips(view())).toEqual([]);
  });
});

describe('card tips', () => {
  it('appends "(no reason given)" for a person or agent hold, and not for an inferred one', () => {
    const tip = (h: Holding) => holdLine(view({ status: 'planning', holding: [h] }))?.tip;
    expect(tip(hold('s1t2'))).toBe('Waits for s1t2 to be merged and rolled out (Doing) (no reason given)');
    expect(tip(hold('s1t2', { source: 'agent' }))).toContain('(no reason given)');
    expect(tip(hold('s1t2', { source: 'inferred' }))).toBe('Waits for s1t2 to be merged and rolled out (Doing)');
    expect(tip(hold('s1t2', { reason: 'same file' }))).toBe('Waits for s1t2 to be merged and rolled out (Doing): same file');
  });

  it('names the other board in a hold and hides a glob on one the viewer is not on', () => {
    const tip = (h: Holding) => holdLine(view({ status: 'planning', holding: [h] }));
    expect(tip(hold('s15t220', { external: { boardId: 15, boardName: 'Ops', hidden: false }, reason: 'rollout' }))?.tip).toContain('s15t220 (board Ops)');
    const hidden = tip(hold('another board', { toTitle: null, reason: 'x', external: { boardId: 9, boardName: null, hidden: true } }));
    expect(hidden?.text).toBe('waiting · a glob on another board');
    expect(hidden?.tip).not.toContain('another board (');
  });

  it('says what it holds back and why, who supersedes it and the failed step question', () => {
    const g = view({
      holdsBack: [{ relationId: 'r1', from: 's1t8', fromTitle: null, gate: 'sign_off', until: 'merged', reason: 'needs the fix', source: 'agent' }],
      relations: related({ supersededBy: { id: 's1t9', title: null, reason: null, source: 'agent' }, waitedOnByOtherBoards: 1 }),
      suggestions: [{ id: 'step:hs_1', kind: 'step_failed', text: 'This step failed: is there a fix glob?', mentioned: null, stepId: 'hs_1' }],
    });
    expect(relationTips(g)).toEqual([
      'Superseded by s1t9 (no reason given)',
      's1t8 waits: needs the fix',
      '1 glob on other boards waits for this',
      'Suggestion: This step failed: is there a fix glob?',
    ]);
  });
});

describe('It failed on a due step', () => {
  const step: ListedHumanStep = { id: 'hs_1', kind: 'rollout', title: 'Run the migration', state: 'due', who: 'admin', due: 'after_merge', blocks: ['sign_off'] };

  it('asks what went wrong and sends one request however often it is clicked', async () => {
    const user = userEvent.setup();
    let finish: (ok: boolean) => void = () => undefined;
    const onFail = vi.fn<(stepId: string, note: string) => Promise<boolean>>(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const glob = view({ status: 'in_progress', humanSteps: [step] });
    render(
      <MemoryRouter>
        <HumanSteps glob={glob} canAdd onAdd={vi.fn()} onComplete={vi.fn()} onDismiss={vi.fn()} onFail={onFail} />
      </MemoryRouter>,
    );
    await user.click(screen.getByTestId('due-failed'));
    expect(screen.getByTestId<HTMLButtonElement>('fail-confirm').disabled).toBe(true);
    await user.type(screen.getByTestId('fail-note'), 'the migration timed out');
    await user.dblClick(screen.getByTestId('fail-confirm'));
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith('hs_1', 'the migration timed out');
    finish(true);
    await waitFor(() => expect(screen.queryByTestId('fail-form')).toBeNull());
  });

  it('has no It failed button when the page cannot report it', () => {
    render(
      <MemoryRouter>
        <HumanSteps glob={view({ status: 'in_progress', humanSteps: [step] })} canAdd onAdd={vi.fn()} onComplete={vi.fn()} onDismiss={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('due-failed')).toBeNull();
  });
});

describe('board settings: automatic relations cost', () => {
  it('shows this month\'s relation_scan spend with the unpriced calls', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <RelationScanSpend boardId={1} />
      </QueryClientProvider>,
    );
    const line = await screen.findByTestId('relation-scan-spend');
    expect(line.textContent).toBe('Automatic relations: $0.0123 this month + 2 unpriced calls');
    expect(line.title).toContain('relation_scan (automatic relations) $0.01 + 2 unpriced');
  });

  it('reads zero when the pass has not run, and labels the source in the breakdown', () => {
    expect(relationScanLine({})).toBe('Automatic relations: $0.0000 this month');
    expect(spendBreakdown({ bySource: { relation_scan: 0.5 }, unpricedCalls: 0 })).toBe('relation_scan (automatic relations) $0.50');
  });
});
