// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Holding, RelationsView, RelationSuggestion } from '@slop/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HumanSteps } from '../src/components/human-steps';
import { RelatedSection } from '../src/components/glob-view/related';
import type { SuggestionHandler } from '../src/components/glob-view/related';
import { RelationScanSpend } from '../src/pages/settings';
import type { AddRelationInput, BoardView, GlobView, ListedHumanStep } from '../src/lib/api';
import { relationScanLine, spendBreakdown } from '../src/lib/review-settings';
import { holdLine, relationTips } from '../src/lib/status-line';
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
  it('badges a person or agent relation with no reason, and no inferred, learned, split or automatic one', () => {
    renderRelated(
      view({
        relations: related({
          holding: [
            hold('s1t2'),
            hold('s1t3', { source: 'agent' }),
            hold('s1t4', { source: 'inferred' }),
            hold('s1t5', { source: 'learned' }),
            hold('s1t6', { source: 'split' }),
            hold('s1t7', { source: 'auto' }),
            hold('s1t8', { reason: 'needs the schema' }),
          ],
        }),
      }),
    );
    expect(screen.getByTestId('no-reason-s1t2').textContent).toBe('no reason given');
    expect(screen.getByTestId('no-reason-s1t3')).not.toBeNull();
    for (const id of ['s1t4', 's1t5', 's1t6', 's1t7', 's1t8']) expect(screen.queryByTestId(`no-reason-${id}`)).toBeNull();
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

describe('Related: automatic relations', () => {
  it('shows "added automatically" with the quoted reason and a one-click dismiss', async () => {
    const user = userEvent.setup();
    const { onDismissEdge } = renderRelated(view({ relations: related({ holding: [hold('s1t7', { source: 'auto', reason: 'only after s1t7 is deployed' })] }) }));
    expect(screen.getByTestId('auto-badge-s1t7').textContent).toBe('added automatically');
    expect(screen.getByTestId('related-row-s1t7').textContent).toContain('“only after s1t7 is deployed”');
    await user.click(screen.getByTestId('dismiss-edge-s1t7'));
    expect(onDismissEdge).toHaveBeenCalledWith('rel_s1t7');
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

describe('Related: suggestions', () => {
  const suggestion = (patch: Partial<RelationSuggestion> = {}): RelationSuggestion => ({
    id: 's1t5:abc',
    kind: 'prerequisite',
    text: 'Mentions s1t5: is it a prerequisite?',
    mentioned: 's1t5',
    gate: 'start',
    ...patch,
  });

  it('accepts and declines a prerequisite suggestion through the handler', async () => {
    const user = userEvent.setup();
    const onSuggestion = vi.fn<SuggestionHandler>(() => Promise.resolve(true));
    renderRelated(view({ relations: related(), suggestions: [suggestion()] }), onSuggestion);
    const item = screen.getByTestId('suggestion-s1t5:abc');
    expect(item.textContent).toContain('Mentions s1t5');
    await user.click(within(item).getByRole('button', { name: 'Add relation' }));
    expect(onSuggestion).toHaveBeenCalledWith('s1t5:abc', 'accept');
    await user.click(within(item).getByRole('button', { name: 'Not a prerequisite' }));
    expect(onSuggestion).toHaveBeenLastCalledWith('s1t5:abc', 'dismiss');
  });

  it('says "Mark superseded" for a supersedes suggestion', () => {
    renderRelated(view({ relations: related(), suggestions: [suggestion({ id: 's1t3:d', kind: 'supersedes', mentioned: 's1t3' })] }), vi.fn());
    expect(screen.getByRole('button', { name: 'Mark superseded' })).not.toBeNull();
  });

  it('links a glob to a failed step: the accept carries the glob ID', async () => {
    const user = userEvent.setup();
    const onSuggestion = vi.fn<SuggestionHandler>(() => Promise.resolve(true));
    renderRelated(
      view({ relations: related(), suggestions: [suggestion({ id: 'step:hs_1', kind: 'step_failed', mentioned: null, text: 'This step failed: is there a fix glob?', stepId: 'hs_1' })] }),
      onSuggestion,
    );
    const link = screen.getByRole('button', { name: 'Link a glob' });
    expect((link as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Glob that fixes it'), 's1b6');
    await user.click(link);
    expect(onSuggestion).toHaveBeenCalledWith('step:hs_1', 'accept', 's1b6');
  });

  it('sends one request for a double click', async () => {
    const user = userEvent.setup();
    let finish: (ok: boolean) => void = () => undefined;
    const onSuggestion = vi.fn<SuggestionHandler>(() => new Promise<boolean>((resolve) => (finish = resolve)));
    renderRelated(view({ relations: related(), suggestions: [suggestion()] }), onSuggestion);
    await user.dblClick(screen.getByTestId('suggestion-accept'));
    expect(onSuggestion).toHaveBeenCalledTimes(1);
    finish(true);
  });

  it('shows the text without buttons when the page cannot answer', () => {
    renderRelated(view({ relations: related(), suggestions: [suggestion()] }));
    expect(screen.getByTestId('suggestion-s1t5:abc').textContent).toContain('Mentions s1t5');
    expect(screen.queryByTestId('suggestion-accept')).toBeNull();
  });
});

describe('an older API without the new fields', () => {
  it('renders a plain relation with no badge-only fields, no suggestions and no supersedes', () => {
    renderRelated(view({ relations: related({ holding: [hold('s1t2', { source: 'inferred' })] }) }));
    expect(screen.getByTestId('related-row-s1t2')).not.toBeNull();
    expect(screen.queryByTestId('related-suggestions')).toBeNull();
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

  it('says what it holds back and why, who supersedes it and the open suggestions', () => {
    const g = view({
      holdsBack: [{ relationId: 'r1', from: 's1t8', fromTitle: null, gate: 'sign_off', until: 'merged', reason: 'needs the fix', source: 'agent' }],
      relations: related({ supersededBy: { id: 's1t9', title: null, reason: null, source: 'agent' }, waitedOnByOtherBoards: 1 }),
      suggestions: [{ id: 's1t5:abc', kind: 'prerequisite', text: 'Mentions s1t5: is it a prerequisite?', mentioned: 's1t5' }],
    });
    expect(relationTips(g)).toEqual([
      'Superseded by s1t9 (no reason given)',
      's1t8 waits: needs the fix',
      '1 glob on other boards waits for this',
      'Suggestion: Mentions s1t5: is it a prerequisite?',
    ]);
  });
});

describe('It failed on a due step', () => {
  const step: ListedHumanStep = { id: 'hs_1', kind: 'rollout', title: 'Run the migration', state: 'due', who: 'admin', due: 'after_merge', blocks: ['sign_off'] };

  it('asks what went wrong and sends one request however often it is clicked', async () => {
    const user = userEvent.setup();
    let finish: (ok: boolean) => void = () => undefined;
    const onFail = vi.fn<(stepId: string, note: string) => Promise<boolean>>(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const glob = view({ humanSteps: [step] });
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
        <HumanSteps glob={view({ humanSteps: [step] })} canAdd onAdd={vi.fn()} onComplete={vi.fn()} onDismiss={vi.fn()} />
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
