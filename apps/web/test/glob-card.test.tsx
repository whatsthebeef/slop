// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobCard } from '../src/components/glob-card';
import type { CardMove } from '../src/components/glob-card';
import { actionPresentation } from '../src/lib/action-presentation';
import type { GlobView } from '../src/lib/api';
import { handoverKey, statusKey } from '../src/lib/dismissals';
import { statusLine } from '../src/lib/status-line';
import { NOW, glob, run } from '../../../packages/core/test/fixtures';

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
    holding: ['s1t1', 's1t2', 's1t3', 's1t4'].map((to) => ({
      relationId: `rel_${to}`,
      to,
      toTitle: null,
      toIsDecision: false,
      gate: 'start' as const,
      until: 'merged' as const,
      state: 'open' as const,
      reason: null,
      source: 'person' as const,
    })),
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
  it('renders the header, title, chips and actions in that order, with no status row under the title', () => {
    const root = dom(markup(prOpen({ allowedActions: ['merge'] })));
    const order = ['card-header', 'card-title', 'card-chips', 'card-actions'].map((id) => {
      const el = root.querySelector(`[data-testid="${id}"]`);
      expect(el, id).not.toBeNull();
      return el;
    });
    for (let i = 1; i < order.length; i++) {
      const [before, el] = [order[i - 1], order[i]];
      expect(before !== null && before !== undefined && el !== null && el !== undefined && (before.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, String(i)).toBe(true);
    }
    for (const gone of ['status-line', 'status-line-open', 'waiting-on', 'waiting-on-open']) expect(root.querySelector(`[data-testid="${gone}"]`), gone).toBeNull();
  });

  it('keeps the one status on a single truncated line that is never centred, with the full text in a tip', () => {
    const root = dom(markup(stalledByConflict()));
    const status = root.querySelector('[data-testid="card-status"]');
    expect(status?.querySelector('.truncate')?.textContent).toMatch(/^merge conflict( · \d+ min)?$/);
    expect(status?.querySelector('button')?.className).toContain('whitespace-nowrap');
    expect(status?.querySelector('button')?.className).toContain('truncate');
    // It shrinks (the ID only at 0.2 of its rate) and may reach zero width; the category icon never does.
    expect(status?.className).toContain('min-w-0');
    expect(status?.className).toContain('shrink');
    expect(status?.className).not.toMatch(/text-center|justify-center|flex-wrap|whitespace-normal/);
    expect(root.querySelector('[data-testid="card-id"]')?.className).toContain('shrink-0');
    expect(root.querySelector('[data-testid="card-id"]')?.className).toContain('gap-[3px]');
    expect(root.querySelector('[data-testid="card-corner"] [role="img"]')?.getAttribute('aria-label')).toBe('task');
    expect(root.querySelector('[data-testid="card-corner"] [role="img"]')?.getAttribute('class')).toContain('shrink-0');
    expect(root.querySelectorAll('[data-testid="card-status"]')).toHaveLength(1);
    expect(root.querySelector('[data-testid="status-line"]')).toBeNull();
  });

  it('keeps a very long status truncated, with the category icon still there and the whole text in the tip', () => {
    const reason = 'A reason that goes on and on about a thing that went wrong in a place nobody expected it to';
    const html = markup(view({ status: 'planning', failure: { reason, at: NOW } }));
    const root = dom(html);
    const status = root.querySelector('[data-testid="card-status"]');
    expect(status?.querySelector('.truncate')).not.toBeNull();
    expect(status?.querySelector('button')?.className).toContain('whitespace-nowrap');
    expect(root.querySelector('[data-testid="card-corner"] [role="img"]')).not.toBeNull();
    expect(html).toContain(reason);
  });

  describe('one status per situation', () => {
    // The card reads the clock, so a run must be fresh or the glob is stalled.
    const live = (state: 'queued' | 'active' | 'watching') => {
      const fresh = new Date().toISOString();
      const r = run({ state, queuedAt: fresh, startedAt: fresh, lastProgressAt: fresh });
      return { runs: [r], currentRun: r };
    };
    const situations: readonly [string, () => GlobView, string, string, string][] = [
      ['machine running', () => view({ status: 'in_progress', ...live('active') }), 'machine-spinning', 'implementing', 'The machine is working on it'],
      ['queued', () => view({ status: 'in_progress', ...live('queued') }), 'machine', 'starting', 'Machine run queued'],
      ['stalled', stalledByConflict, 'alert', 'merge conflict', 'Merge conflict with main in'],
      ['your turn', () => prOpen({ allowedActions: ['merge'] }), 'human', 'Merge', 'Opens the glob'],
      ['waiting on prerequisites', waitingOn, 'hourglass', 'waiting on s1t1 +3', 'Waits for, in order: s1t1 (Doing)'],
      ['checks running', () => prOpen({ headChecks: { sha: head, state: 'pending' }, ...live('watching') }), 'hourglass', 'checks running', 'Waiting'],
      ['a problem', () => conflicting(), 'alert', 'conflicts with main', files[0] ?? ''],
    ];
    it.each(situations)('%s: exactly one status in the header, the icon and the words, the detail in the tip, no row under the title', (_name, make, icon, text, detail) => {
      const html = markup(make());
      const root = dom(html);
      const statuses = root.querySelectorAll('[data-testid="card-status"]');
      expect(statuses).toHaveLength(1);
      expect(root.querySelector('[data-testid="card-header"]')?.contains(statuses[0] ?? null)).toBe(true);
      expect(statuses[0]?.getAttribute('data-icon')).toBe(icon);
      expect(statuses[0]?.querySelector('.truncate')?.textContent).toBe(text);
      // No elapsed times and no commit SHAs in the visible text.
      expect(statuses[0]?.querySelector('.truncate')?.textContent).not.toMatch(/\bmin\b|\b[0-9a-f]{7}\b/);
      expect(statuses[0]?.querySelector('.truncate')?.textContent).not.toMatch(/working|stalled/i);
      expect(root.querySelector('[data-testid="status-line"]')).toBeNull();
      expect(statuses[0]?.querySelector('.sr-only')?.textContent).toContain(detail);
    });

    it('escalated in Planning: "needs a" and the person icon, the reason in the tip', () => {
      const root = dom(markup(view({ status: 'planning', escalation: { reason: 'touches billing', at: NOW } as GlobView['escalation'] })));
      const status = root.querySelector('[data-testid="card-status"]');
      expect(status?.getAttribute('data-icon')).toBe('needs-human');
      expect(status?.textContent).toContain('needs a');
      expect(status?.querySelector('.sr-only')?.textContent).toContain('touches billing');
    });

    it('shows no status and no status row for a Planning glob with nothing pending', () => {
      const root = dom(markup(view({ status: 'planning' })));
      expect(root.querySelector('[data-testid="card-status"]')).toBeNull();
      expect(root.querySelector('[data-testid="status-line"]')).toBeNull();
    });
  });

  it('shows only a relation that holds the glob back now, as the one status, and no overlaps chip', () => {
    const hold = (to: string, patch: Partial<NonNullable<GlobView['holding']>[number]> = {}) => ({
      relationId: `rel_${to}`,
      to,
      toTitle: null,
      toIsDecision: false,
      gate: 'start' as const,
      until: 'merged' as const,
      state: 'open' as const,
      reason: null,
      source: 'person' as const,
      ...patch,
    });
    const decisionHeld = dom(markup(view({ status: 'planning', holding: [hold('s1k9', { toIsDecision: true, until: 'decided', state: 'planning' })] })));
    expect(decisionHeld.querySelector('[data-testid="card-status"] .truncate')?.textContent).toBe('waiting on decision s1k9');
    // A start relation holds nothing once the glob has started, and nothing relation-shaped is left on the card.
    const started = dom(markup(view({ status: 'in_progress', holding: [hold('s1t1')] })));
    expect(started.textContent).not.toContain('waiting on');
    // Predicted overlaps are internal: even when a view still carries them, no chip.
    const legacy = view({ status: 'planning', impliedAfter: [{ id: 's1t5', paths: ['a.ts'] }] });
    const html = markup(legacy);
    expect(html).not.toContain('overlap');
    expect(dom(html).querySelector('[data-testid="overlap-chip"]')).toBeNull();
  });

  it('puts the category icon last in the header, the status just before it, and the ID on the left', () => {
    const root = dom(markup(stalledByConflict()));
    const header = root.querySelector('[data-testid="card-header"]');
    const corner = header?.querySelector('[data-testid="card-corner"]');
    expect(header?.lastElementChild).toBe(corner);
    expect(corner?.lastElementChild?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('task');
    const separator = corner?.lastElementChild?.previousElementSibling;
    expect(separator?.getAttribute('data-testid')).toBe('card-corner-separator');
    expect(separator?.textContent).toBe('·');
    expect(separator?.getAttribute('aria-hidden')).toBe('true');
    expect(separator?.previousElementSibling?.getAttribute('data-testid')).toBe('card-status');
    expect(header?.firstElementChild?.getAttribute('data-testid')).toBe('card-id');
    expect(header?.firstElementChild?.className).toContain('shrink-0');
    expect(header?.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it('orders the corner: status text, then the status icon, then the category icon', () => {
    const root = dom(markup(stalledByConflict()));
    const button = root.querySelector('[data-testid="card-status"] button');
    const kids = Array.from(button?.children ?? []);
    expect(kids[0]?.getAttribute('data-testid')).toBe('status-text');
    expect(kids[1]?.tagName.toLowerCase()).toBe('svg');
    const corner = root.querySelector('[data-testid="card-corner"]');
    expect(corner?.children[0]?.getAttribute('data-testid')).toBe('card-status');
  });

  it('lets only the status text truncate, never the ID', () => {
    const root = dom(markup(stalledByConflict()));
    expect(root.querySelector('[data-testid="status-text"]')?.className).toContain('truncate');
    expect(root.querySelector('[data-testid="card-status"]')?.className).toContain('min-w-0');
    expect(root.querySelector('[data-testid="card-status"] button')?.className).not.toMatch(/max-w-\[|max-w-\d/);
  });

  describe('avatar', () => {
    const avatar = (g: GlobView) => dom(markup(g)).querySelector('[data-testid="card-bottom"]');
    it('sits at the bottom-right for a person-implemented glob', () => {
      const bottom = avatar(prOpen({ implementer: 'john.bower@x.com' }));
      expect(bottom?.lastElementChild?.textContent).toContain('JB');
      expect(bottom?.className).toContain('justify-between');
      expect(bottom?.textContent).toContain('Implementer: john.bower@x.com');
    });
    it('shows the planner while unassigned', () => {
      const g = view({ implementer: null, planner: 'ann@x.com', runs: [] });
      expect(avatar(g)?.lastElementChild?.textContent).toContain('AN');
      expect(avatar(g)?.textContent).toContain('Planner');
    });
    it('shows the planner when the machine is implementing', () => {
      const bottom = avatar(view({implementer: null, planner: 'ann@x.com', generation: 1, runs: [run()]}));
      expect(bottom?.textContent).toContain('Planner: ann@x.com');
      expect(bottom?.lastElementChild?.textContent).toContain('AN');
    });
    it('shows the robot head for a slop-planned glob', () => {
      const bottom = avatar(view({implementer: null, planner: 'slop', runs: []}));
      expect(bottom?.textContent).toContain('Planner: slop (machine)');
      expect(bottom?.lastElementChild?.querySelector('[aria-label="machine"]')).not.toBeNull();
    });
  });

  describe('dismissing', () => {
    const states: readonly [string, () => GlobView][] = [
      ['a failure', () => view({ status: 'failed', failure: { reason: 'Run failed', at: NOW } })],
      ['a stall', stalledByConflict],
      ['a conflict', conflicting],
      ['a handover', () => prOpen({ handover: { why: ['Checks failed'], next: 'Fix them', detail: [] } as unknown as GlobView['handover'] })],
    ];
    /** Every key the glob view would store for this glob's messages, built the way the glob view builds them. */
    const keysOf = (g: GlobView): string[] => {
      const line = statusLine(g, NOW);
      return [...(line === null ? [] : [statusKey(g, line)]), ...(g.handover == null ? [] : [handoverKey(g.handover)])];
    };

    it.each(states)('renders no dismiss control on the card for %s', (_name, make) => {
      const html = markup(make());
      expect(html).not.toMatch(/dismiss|got it/i);
      expect(withoutTips(html)).not.toMatch(/[×✕]/);
    });

    it.each(states)('shows the same short label for %s whether or not it was dismissed in the glob view', (_name, make) => {
      const g = make();
      const keys = keysOf(g);
      expect(keys.length).toBeGreaterThan(0);
      expect(markup({ ...g, dismissedKeys: keys })).toBe(markup(g));
    });
  });

  it('shows a merge-conflict stall once, short, with no file names; the tooltip has the full reason', () => {
    const html = markup(stalledByConflict());
    const text = withoutTips(html);
    expect(text).toContain('merge conflict');
    expect(text).not.toMatch(/stalled/i);
    expect(text.match(/conflict/g)).toHaveLength(1);
    expect(text).not.toMatch(/\.tsx?|apps\/|Merge conflict with main in/);
    const line = dom(html).querySelector('[data-testid="card-status"] .truncate')?.textContent ?? '';
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

  it('says what it waits on once, as plain text in the one status, and never "blocked by"', () => {
    const html = markup(waitingOn());
    const root = dom(html);
    const status = root.querySelector('[data-testid="card-status"]');
    expect(status?.querySelector('.truncate')?.textContent).toBe('waiting on s1t1 +3');
    expect(root.querySelector('[data-testid="card-header"] a')).toBeNull();
    expect(root.querySelector('[data-testid="waiting-on"]')).toBeNull();
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
    expect(chip?.textContent).toBe('s1t5');
    const link = chip?.querySelector('a');
    expect(link?.textContent).toBe('s1t5');
    expect(link?.getAttribute('aria-label')).toBe('Split from s1t5');
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

describe('independent review on the card', () => {
  const reviewed = (findings: number, headSha: string | null = head) =>
    view({
      pr: { state: 'draft', number: 1, headSha: head },
      artifacts: [
        {
          kind: 'independent_review',
          label: '',
          version: 1,
          versions: 1,
          commitSha: headSha,
          createdAt: NOW,
          by: 'reviewer',
          actor: 'slop',
          review: { stage: 'pre_merge', headSha, findings, high: 0, medium: 0, low: 0 },
        },
      ],
    });

  it('shows no artifact icons or review status on the card', () => {
    const root = dom(markup(reviewed(2)));
    expect(root.querySelector('[data-testid^="artifact-icon-"]')).toBeNull();
    expect(root.querySelector('[data-testid="review-status"]')).toBeNull();
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
    const onAct = vi.fn();
    render(
      <MemoryRouter>
        <GlobCard {...props} glob={g} onAct={onAct} repo='a/b' {...extra} />
      </MemoryRouter>,
    );
    return { ...props, onAct };
  };

  it('filters to the group when its tag is clicked, without opening the card', async () => {
    const user = userEvent.setup();
    const onFilterGroup = vi.fn();
    const { onOpen } = renderCard(view({ group: 'glob-groups' }), { onFilterGroup });
    await user.click(screen.getByTestId('group-chip'));
    expect(onFilterGroup).toHaveBeenCalledWith('glob-groups');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('has no title edit affordance: the title is plain wrapping text and clicking it opens the glob', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderCard(view());
    expect(screen.queryByTestId('card-title-edit')).toBeNull();
    expect(screen.queryByTestId('card-title-input')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    const title = screen.getByTestId('card-title');
    expect(title.textContent).toBe('Fix login timeout');
    expect(title.className).toContain('break-words');
    await user.click(title);
    expect(onOpen).toHaveBeenCalled();
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

  it('never runs Your turn from the status: it opens the glob view, and the tooltip says so', async () => {
    const user = userEvent.setup();
    const g = prOpen({ allowedActions: ['merge'] });
    const { onOpenSection, onOpen, onAct } = renderCard(g);
    await user.click(screen.getByTestId('position'));
    expect(onOpenSection).toHaveBeenCalledWith({ section: 'actions' });
    expect(onAct).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('card-status').querySelector('.sr-only')?.textContent.endsWith('Opens the glob')).toBe(true);
  });

  it('opens the glob view at the section from the status without running anything', async () => {
    const user = userEvent.setup();
    const { onOpenSection, onOpen, onAct } = renderCard(conflicting());
    await user.click(screen.getByTestId('position'));
    expect(onOpenSection).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onAct).not.toHaveBeenCalled();
  });

  it('shows a move tag in the status slot in place of the status, with no separate line', () => {
    const g = conflicting();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <GlobCard {...base()} glob={g} repo='a/b' tag={{ text: 'picked up by JB', icon: 'human', n: 1 }} />
      </MemoryRouter>,
    );
    const root = dom(html);
    const statuses = root.querySelectorAll('[data-testid="card-status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.getAttribute('data-kind')).toBe('move-tag');
    expect(statuses[0]?.textContent).toBe('picked up by JB');
    expect(root.querySelectorAll('.move-tag')).toHaveLength(1);
    expect(root.querySelector('[data-testid="card-corner"] .move-tag')).not.toBeNull();
    expect(markup(g)).not.toContain('move-tag');
  });
});
