// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobCard } from '../src/components/glob-card';
import type { CardMove } from '../src/components/glob-card';
import { actionPresentation } from '../src/lib/action-presentation';
import type { GlobView } from '../src/lib/api';
import { NOW, glob } from '../../../packages/core/test/fixtures';

afterEach(cleanup);

const head = 'd16d563aaaa';
const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;
const prOpen = (patch: Partial<GlobView> = {}) =>
  view({ type: 'same', status: 'pr_open', pr: { number: 289, state: 'ready', headSha: head }, headChecks: { sha: head, state: 'passed' }, ...patch });
const files = ['apps/web/src/components/glob-dialog.tsx', 'apps/web/src/pages/board.tsx'];
const stalledByConflict = () =>
  view({
    status: 'failed',
    failure: { reason: `Merge conflict with main in ${files.join(', ')}`, at: NOW, kind: 'merge', conflict: { base: 'main', files } },
  });
const conflicting = () => prOpen({ implementer: 'dev@example.com', conflict: { base: 'main', files, since: 's1t9', at: NOW } });
const waitingOn = () =>
  view({
    status: 'planning',
    blockedBy: ['s1t1', 's1t2', 's1t3', 's1t4'].map((id, i) => ({ id, state: 'open' as const, status: 'implementing' as const, depth: i + 1 })),
    nextStartable: 's1t9',
  });
const move = (action: 'start' | 'pick_up', g: GlobView): CardMove => {
  const { label, tip, icon } = actionPresentation(action, g);
  return { action, direction: 'right', label: `${label} ▸`, description: `${label} ${g.id}: ${tip}`, icon };
};

const base = () => ({
  onOpen: vi.fn(),
  onOpenSection: vi.fn(),
  onReviewLabel: vi.fn(),
  moves: [] as readonly CardMove[],
  previewing: null,
  onPreview: vi.fn(),
  onMove: vi.fn(),
  onArrow: vi.fn(),
});

const markup = (g: GlobView, moves: readonly CardMove[] = []) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <GlobCard {...base()} moves={moves} glob={g} repo='a/b' />
    </MemoryRouter>,
  );
const dom = (html: string) => {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
};
/** What a person reads on the card: the markup without the tooltips' hidden text. */
const visible = (html: string) => (dom(html).querySelector('[data-glob-id]')?.cloneNode(true) as HTMLElement | null)?.textContent ?? '';
const withoutTips = (html: string) => visible(html.replace(/<span id="[^"]+" class="sr-only">[\s\S]*?<\/span>/g, ''));

describe('card rows', () => {
  it('renders the header, title, status line, chips and actions in that order', () => {
    const root = dom(markup(prOpen({ allowedActions: ['merge'] })));
    const order = ['card-header', 'card-title', 'status-line', 'card-chips', 'card-actions'].map((id) => {
      const el = root.querySelector(`[data-testid="${id}"]`);
      expect(el, id).not.toBeNull();
      return el;
    });
    for (let i = 1; i < order.length; i++) {
      const [before, el] = [order[i - 1], order[i]];
      expect(before !== null && before !== undefined && el !== null && el !== undefined && (before.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, String(i)).toBe(true);
    }
  });

  it('keeps the status line and corner marker on one left-aligned truncated line with the full text in a tip', () => {
    const root = dom(markup(stalledByConflict()));
    const line = root.querySelector('[data-testid="status-line"]');
    expect(line?.className).toContain('whitespace-nowrap');
    expect(line?.className).toContain('truncate');
    expect(line?.className).toContain('text-left');
    expect(line?.className).not.toMatch(/text-center|justify-center/);
    const corner = root.querySelector('[data-testid="corner-marker"]');
    expect(corner?.querySelector('.truncate')?.textContent).toBe('stalled');
    expect(corner?.querySelector('button')?.className).toContain('whitespace-nowrap');
    expect(corner?.className).toContain('max-w-[45%]');
    expect(corner?.className).not.toMatch(/text-center|justify-center/);
    expect(root.querySelectorAll('[data-testid="corner-marker"]')).toHaveLength(1);
  });

  describe('dismissing', () => {
    const states: readonly [string, () => GlobView][] = [
      ['a failure', () => view({ status: 'failed', failure: { reason: 'Run failed', at: NOW } })],
      ['a stall', stalledByConflict],
      ['a conflict', conflicting],
      ['a handover', () => prOpen({ handover: { why: ['Checks failed'], next: 'Fix them', detail: [] } as unknown as GlobView['handover'] })],
    ];
    const keys = [`failure:${NOW}`, `conflict:${NOW}`, 'stall:x', 'handover:x', 'checks:x'];

    it.each(states)('renders no dismiss control on the card for %s', (_name, make) => {
      const html = markup(make());
      expect(html).not.toMatch(/dismiss|got it/i);
      expect(withoutTips(html)).not.toMatch(/[×✕]/);
    });

    it.each(states)('shows the same short label for %s whether or not it was dismissed in the glob view', (_name, make) => {
      const g = make();
      expect(markup({ ...g, dismissedKeys: keys })).toBe(markup(g));
    });
  });

  it('shows a merge-conflict stall once, short, with no file names; the tooltip has the full reason', () => {
    const html = markup(stalledByConflict());
    const text = withoutTips(html);
    expect(text).toContain('stalled · merge conflict');
    expect(text.match(/conflict/g)).toHaveLength(1);
    expect(text).not.toMatch(/\.tsx?|apps\/|Merge conflict with main in/);
    const line = dom(html).querySelector('[data-testid="status-line"]')?.textContent ?? '';
    expect(line.length).toBeLessThanOrEqual(40);
    expect(html).toContain(`Merge conflict with main in ${files.join(', ')}`);
  });

  it('shows "conflicts with main" once for a conflicting glob, with files and advice only in the tooltip', () => {
    const html = markup(conflicting());
    const text = withoutTips(html);
    expect(text.match(/conflicts with main/g)).toHaveLength(1);
    expect(text).not.toMatch(/\.tsx?|apps\/|Resolve locally|since s1t9/);
    expect(html).toContain(files[0]);
    expect(html).toContain('Resolve locally');
  });

  it('says what it waits on once, with linked IDs, and never "blocked by"', () => {
    const html = markup(waitingOn());
    const root = dom(html);
    const waiting = root.querySelector('[data-testid="waiting-on"]');
    expect(waiting?.textContent).toBe('waiting on s1t1, s1t2 +2 · next: s1t9');
    expect([...(waiting?.querySelectorAll('a') ?? [])].map((a) => a.textContent)).toEqual(['s1t1', 's1t2', 's1t9']);
    expect(html).not.toMatch(/blocked by/i);
    expect(html).not.toContain('after-chip');
    expect(html).toContain('Waits for, in order: s1t1 (Doing)');
  });

  it('puts the split chip in the chips row as a pill with the branch icon, not in the title or status line', () => {
    const g = view({ status: 'planning', split: { source: 's1t5', part: 1, parts: ['s1t5', 's1t1'] } });
    const root = dom(markup(g));
    const chip = root.querySelector('[data-testid="split-chip"]');
    expect(root.querySelector('[data-testid="card-chips"]')?.contains(chip ?? null)).toBe(true);
    expect(chip?.className).toContain('bg-muted');
    expect(chip?.className).toContain('rounded-full');
    expect(chip?.className).toContain('font-sans');
    expect(chip?.querySelector('svg.lucide-git-branch')).not.toBeNull();
    expect(chip?.textContent).toBe('split from s1t5');
    expect(root.querySelector('[data-testid="card-title"]')?.textContent).not.toContain('split');
    expect(root.querySelector('[data-testid="status-line"]')).toBeNull();
  });

  it('keeps chip text on one line', () => {
    const root = dom(markup(view({ status: 'planning', group: 'a-rather-long-group-name', clash: { with: 's1t2', paths: ['a.ts'] } })));
    expect(root.querySelector('[data-testid="clash-chip"]')?.className).toContain('whitespace-nowrap');
    expect(root.querySelector('[data-testid="card-chips"]')?.className).toContain('flex-wrap');
    // The clash's paths live in the glob view, not in the card's tooltip.
    expect(root.innerHTML).not.toContain('a.ts');
  });
});

describe('card actions', () => {
  it('shows Start and Pick up for an unblocked same in Planning', () => {
    const g = view({ type: 'same', status: 'planning' });
    const html = markup(g, [move('start', g), move('pick_up', g)]);
    expect(html).toContain('data-testid="move-start"');
    expect(html).toContain('data-testid="move-pick_up"');
  });

  it('shows no buttons with any blocker, and no empty actions row', () => {
    const planning = (patch: Partial<GlobView>) => view({ type: 'same', status: 'planning', ...patch });
    const blockers: Record<string, GlobView> = {
      'unmerged needs': waitingOn(),
      escalation: planning({ escalation: { reason: 'billing', at: NOW } as GlobView['escalation'] }),
      stall: planning({ provisioning: 'failed' }),
    };
    for (const [name, g] of Object.entries(blockers)) {
      const html = markup(g, [move('start', g), move('pick_up', g)]);
      expect(html, name).not.toContain('data-testid="move-');
      expect(html, name).not.toContain('card-actions');
    }
    const merge = markup(conflicting());
    expect(merge).not.toContain('your-turn-chip');
  });

  it('offers Merge when nothing blocks it', () => {
    expect(markup(prOpen({ allowedActions: ['merge'] }))).toMatch(/<button[^>]*aria-label="Your turn: Merge PR #289"[^>]*data-testid="your-turn-chip"/);
  });
});

describe('card interaction', () => {
  const renderCard = (g: GlobView, extra: Partial<Parameters<typeof GlobCard>[0]> = {}) => {
    const props = base();
    const onUpdateTitle = vi.fn(() => Promise.resolve(null));
    const onAct = vi.fn();
    render(
      <MemoryRouter>
        <GlobCard {...props} glob={g} onUpdateTitle={onUpdateTitle} onReload={() => Promise.resolve()} onAct={onAct} repo='a/b' {...extra} />
      </MemoryRouter>,
    );
    return { ...props, onUpdateTitle, onAct };
  };

  it('edits the title in place: Enter saves through the update call and the card does not open', async () => {
    const user = userEvent.setup();
    const { onOpen, onUpdateTitle } = renderCard(view());
    await user.click(screen.getByTestId('card-title-edit'));
    const input = screen.getByTestId('card-title-input');
    expect(input.tagName).toBe('TEXTAREA');
    await user.clear(input);
    await user.type(input, 'A new title{Enter}');
    expect(onUpdateTitle).toHaveBeenCalledTimes(1);
    expect(onUpdateTitle).toHaveBeenCalledWith({ title: 'A new title' });
    await waitFor(() => expect(screen.queryByTestId('card-title-input')).toBeNull());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('cancels with Esc: nothing is saved, the textarea goes and the card does not open', async () => {
    const user = userEvent.setup();
    const { onOpen, onUpdateTitle } = renderCard(view());
    await user.click(screen.getByTestId('card-title-edit'));
    await user.type(screen.getByTestId('card-title-input'), ' more{Escape}');
    expect(screen.queryByTestId('card-title-input')).toBeNull();
    expect(onUpdateTitle).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('refuses an empty title', async () => {
    const user = userEvent.setup();
    const { onUpdateTitle } = renderCard(view());
    await user.click(screen.getByTestId('card-title-edit'));
    await user.clear(screen.getByTestId('card-title-input'));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert').textContent).toContain("can't be empty");
    expect(onUpdateTitle).not.toHaveBeenCalled();
  });

  it('shows a refused save under the title, with the draft kept', async () => {
    const user = userEvent.setup();
    const refused = vi.fn(() => Promise.resolve({ message: 'Changed meanwhile', conflict: true }));
    renderCard(view(), { onUpdateTitle: refused });
    await user.click(screen.getByTestId('card-title-edit'));
    await user.type(screen.getByTestId('card-title-input'), '!{Enter}');
    expect((await screen.findByRole('alert')).textContent).toContain('Changed meanwhile');
    expect(screen.getByRole('button', { name: 'Reload latest' })).toBeTruthy();
    expect(screen.getByTestId<HTMLTextAreaElement>('card-title-input').value).toContain('!');
  });

  it('has plain text for a title that cannot be edited (a signed-off glob, or no update call)', () => {
    renderCard(view({ status: 'signed_off' }));
    expect(screen.queryByTestId('card-title-edit')).toBeNull();
    expect(screen.getByTestId('card-title').textContent).toBe('Fix login timeout');
  });

  it('keeps Merge a two-step confirm from the actions row', async () => {
    const user = userEvent.setup();
    const { onAct, onOpen } = renderCard(prOpen({ allowedActions: ['merge'] }));
    await user.click(screen.getByTestId('your-turn-chip'));
    expect(screen.getByTestId('your-turn-chip').textContent).toBe('Confirm merge #289');
    expect(onAct).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('your-turn-chip'));
    expect(onAct).toHaveBeenCalledWith('merge');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('never runs Your turn from the status line: it opens the glob view, and the tooltip says so', async () => {
    const user = userEvent.setup();
    const g = prOpen({ allowedActions: ['merge'] });
    const { onOpenSection, onOpen, onAct } = renderCard(g);
    await user.click(screen.getByTestId('status-line-open'));
    expect(onOpenSection).toHaveBeenCalledWith({ section: 'actions' });
    expect(onAct).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('status-line').parentElement?.querySelector('.sr-only')?.textContent.endsWith('Opens the glob')).toBe(true);
  });

  it('opens the glob view at the section from the status line without running anything', async () => {
    const user = userEvent.setup();
    const { onOpenSection, onOpen, onAct } = renderCard(conflicting());
    await user.click(screen.getByTestId('status-line-open'));
    expect(onOpenSection).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onAct).not.toHaveBeenCalled();
  });
});
