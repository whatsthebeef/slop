// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobCard } from '../src/components/glob-card';
import type { GlobView } from '../src/lib/api';
import type { WorkstreamsSummary, WorkstreamState } from '@slop/core';
import { armLabel, listOf } from '@slop/core';
import { CONFIRM_MS } from '../src/lib/use-confirm-click';
import { clickOf } from '../src/lib/present';
import { NOW, glob, run } from '../../../packages/core/test/fixtures';

afterEach(cleanup);

const head = 'd16d563aaaa';
const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), list: listOf(patch.status ?? 'planning'), ...patch }) as GlobView;
const prOpen = (patch: Partial<GlobView> = {}) =>
  view({ type: 'same', status: 'pr_open', pr: { number: 289, state: 'ready', headSha: head }, headChecks: { sha: head, state: 'passed' }, ...patch });
const files = ['apps/web/src/components/glob-dialog.tsx', 'apps/web/src/pages/board.tsx'];
const stalledByConflict = () =>
  view({
    category: 'bug',
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
const base = () => ({
  onOpen: vi.fn(),
  onOpenSection: vi.fn(),
  previewing: null,
  onPreview: vi.fn(),
  onMove: vi.fn(),
  onArrow: vi.fn(),
});

const markup = (g: GlobView) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <GlobCard {...base()} glob={g} repo='a/b' />
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
  it('shows no Oversized chip on a flagged glob', () => {
    const root = dom(markup(view({ oversized: true })));
    expect(root.querySelector('[data-testid="oversized-chip"]')).toBeNull();
    expect(withoutTips(markup(view({ oversized: true })))).not.toContain('Oversized');
  });

  it('renders the header, title, group tag and bottom row in that order, with no status row under the title', () => {
    const g = view({ group: 'glob-groups', type: 'sub', status: 'planning', list: 'planning', allowedActions: ['start'] });
    const root = dom(markup(g));
    const order = ['card-header', 'card-title', 'card-chips', 'card-bottom'].map((id) => {
      const el = root.querySelector(`[data-testid="${id}"]`);
      expect(el, id).not.toBeNull();
      return el;
    });
    for (let i = 1; i < order.length; i++) {
      const [before, el] = [order[i - 1], order[i]];
      expect(before !== null && before !== undefined && el !== null && el !== undefined && (before.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, String(i)).toBe(true);
    }
    for (const gone of ['status-line', 'status-line-open', 'waiting-on', 'waiting-on-open', 'card-pending']) expect(root.querySelector(`[data-testid="${gone}"]`), gone).toBeNull();
  });

  it('shows "N waiting on this" as the status, with no separate text lower on the card', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <GlobCard {...base()} glob={view({ status: 'planning' })} repo='a/b' waitingOnThis={2} />
      </MemoryRouter>,
    );
    const root = dom(html);
    expect(root.querySelector('[data-testid="card-status"] [data-testid="status-text"]')?.textContent).toBe('2 waiting on this');
    expect(root.querySelector('[data-testid="waiting-on-this-chip"]')).toBeNull();
    expect(root.querySelector('[data-testid="card-chips"]')?.textContent ?? '').not.toContain('waiting on this');
  });

  it('keeps the one status on a single truncated line that is never centred, with the full text in a tip', () => {
    const root = dom(markup(stalledByConflict()));
    const status = root.querySelector('[data-testid="card-status"]');
    expect(status?.querySelector('.truncate')?.textContent).toMatch(/^merge conflict( · \d+ min)?$/);
    expect(status?.querySelector('button')?.className).toContain('whitespace-nowrap');
    expect(status?.querySelector('button')?.className).toContain('truncate');
    // It shrinks (the ID only at 0.2 of its rate) and may reach zero width; the fix marker never does.
    expect(status?.className).toContain('min-w-0');
    expect(status?.className).toContain('shrink');
    expect(status?.className).not.toMatch(/text-center|justify-center|flex-wrap|whitespace-normal/);
    expect(root.querySelector('[data-testid="card-id"]')?.className).toContain('shrink-0');
    expect(root.querySelector('[data-testid="card-id"]')?.className).toContain('gap-[3px]');
    expect(root.querySelector('[data-testid="card-corner"] [role="img"]')?.getAttribute('aria-label')).toBe('bug');
    expect(root.querySelector('[data-testid="card-corner"] [role="img"]')?.getAttribute('class')).toContain('shrink-0');
    expect(root.querySelectorAll('[data-testid="card-status"]')).toHaveLength(1);
    expect(root.querySelector('[data-testid="status-line"]')).toBeNull();
  });

  it('keeps a very long status truncated, with the fix marker still there and the whole text in the tip', () => {
    const reason = 'A reason that goes on and on about a thing that went wrong in a place nobody expected it to';
    const html = markup(view({ category: 'bug', status: 'planning', failure: { reason, at: NOW } }));
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
      ['your turn', () => prOpen({ allowedActions: ['merge'] }), 'human', 'Merge', 'Opens the glob.'],
      ['waiting on prerequisites', waitingOn, 'hourglass', 'waiting · s1t1 +3', 'Waits for s1t1 to be merged and rolled out (Doing)'],
      ['running checks', () => prOpen({ headChecks: { sha: head, state: 'pending' }, ...live('watching') }), 'hourglass', 'running checks', 'Checks are running on d16d563'],
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

    it('a merging glob says "merging" once, in the corner only, with the SHA in the tip', () => {
      const fresh = new Date().toISOString();
      const r = run({ state: 'watching', queuedAt: fresh, startedAt: fresh, lastProgressAt: fresh });
      const html = markup(prOpen({ mergeMode: 'when_green', headChecks: { sha: head, state: 'pending' }, runs: [r], currentRun: r }));
      const root = dom(html);
      const statuses = root.querySelectorAll('[data-testid="card-status"]');
      expect(statuses).toHaveLength(1);
      expect(root.querySelector('[data-testid="card-header"]')?.contains(statuses[0] ?? null)).toBe(true);
      expect(statuses[0]?.querySelector('.truncate')?.textContent).toMatch(/^running checks/);
      expect(statuses[0]?.querySelector('.truncate')?.textContent).not.toMatch(/\b[0-9a-f]{7}\b/);
      // Outside the corner status (whose tooltip text is its own) the card never says it.
      statuses[0]?.remove();
      expect(root.textContent.match(/merging/gi)).toBeNull();
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
    expect(decisionHeld.querySelector('[data-testid="card-status"] .truncate')?.textContent).toBe('waiting · decision s1k9');
    // A start relation holds nothing once the glob has started, and nothing relation-shaped is left on the card.
    const started = dom(markup(view({ status: 'in_progress', holding: [hold('s1t1')] })));
    expect(started.textContent).not.toContain('waiting on');
    // Predicted overlaps are internal: even when a view still carries them, no chip.
    const legacy = view({ status: 'planning', impliedAfter: [{ id: 's1t5', paths: ['a.ts'] }] });
    const html = markup(legacy);
    expect(html).not.toContain('overlap');
    expect(dom(html).querySelector('[data-testid="overlap-chip"]')).toBeNull();
  });

  it('puts the kind marker last in the header, the status just before it, and the ID on the left', () => {
    const root = dom(markup(stalledByConflict()));
    const header = root.querySelector('[data-testid="card-header"]');
    const corner = header?.querySelector('[data-testid="card-corner"]');
    expect(header?.lastElementChild).toBe(corner);
    expect(corner?.lastElementChild?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('bug');
    const separator = corner?.lastElementChild?.previousElementSibling;
    expect(separator?.getAttribute('data-testid')).toBe('card-corner-separator');
    expect(separator?.textContent).toBe('·');
    expect(separator?.getAttribute('aria-hidden')).toBe('true');
    expect(separator?.previousElementSibling?.getAttribute('data-testid')).toBe('card-status');
    expect(header?.firstElementChild?.getAttribute('data-testid')).toBe('card-id');
    expect(header?.firstElementChild?.className).toContain('shrink-0');
    expect(header?.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it('orders the corner: status text, then the status icon, then the kind marker', () => {
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
    it('shares the group tag row on the right, with no avatar in the bottom row, for a grouped glob', () => {
      const root = dom(markup(prOpen({ group: 'glob-groups', implementer: 'john.bower@x.com' })));
      const row = root.querySelector('[data-testid="card-group-row"]');
      expect(row?.querySelector('[data-testid="group-chip"], [data-testid="card-chips"]')).not.toBeNull();
      expect(row?.lastElementChild?.textContent).toContain('JB');
      expect(root.querySelector('[data-testid="card-bottom"]')?.textContent ?? '').not.toContain('JB');
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
    it('shows the implementer over the planner', () => {
      const bottom = avatar(view({implementer: 'bo@x.com', planner: 'ann@x.com', runs: []}));
      expect(bottom?.textContent).toContain('Implementer: bo@x.com');
      expect(bottom?.lastElementChild?.textContent).toContain('BO');
    });
    it('shows the robot head for a bot planner account', () => {
      const bottom = avatar(view({implementer: null, planner: 'ci-bot@x.com', runs: []}));
      expect(bottom?.textContent).toContain('Planner: ci-bot@x.com (machine)');
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
    it.each(states)('renders no dismiss control on the card for %s', (_name, make) => {
      const html = markup(make());
      expect(html).not.toMatch(/dismiss|got it/i);
      expect(withoutTips(html)).not.toMatch(/[×✕]/);
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
    expect(status?.querySelector('.truncate')?.textContent).toBe('waiting · s1t1 +3');
    expect(root.querySelector('[data-testid="card-header"] a')).toBeNull();
    expect(root.querySelector('[data-testid="waiting-on"]')).toBeNull();
    expect(html).not.toMatch(/blocked by/i);
    expect(html).not.toContain('after-chip');
    expect(html).toContain('Waits for s1t1 to be merged and rolled out (Doing)');
  });

  it('has no split chip: a part of a split shows nothing about it on the card', () => {
    const g = view({ status: 'planning', split: { source: 's1t5', part: 1, parts: ['s1t5', 's1t1'] } });
    const root = dom(markup(g));
    expect(root.querySelector('[data-testid="split-chip"]')).toBeNull();
    expect(root.querySelector('svg.lucide-git-branch')).toBeNull();
    expect(visible(markup(g))).not.toContain('s1t5');
  });

  it('keeps chip text on one line', () => {
    const root = dom(markup(view({ status: 'planning', group: 'a-rather-long-group-name', clash: { with: 's1t2', paths: ['a.ts'] } })));
    expect(root.querySelector('[data-testid="card-chips"]')?.className).toContain('flex-wrap');
    // A clash shows no chip on the card, and its paths live in the glob view.
    expect(root.querySelector('[data-testid="clash-chip"]')).toBeNull();
    expect(root.textContent).not.toContain('clashes with');
    expect(root.innerHTML).not.toContain('a.ts');
  });
});

describe('question and branch lines on the card', () => {
  const asked = { id: 'q1', text: 'Is prod in scope?', raisedBy: { kind: 'intake', actor: null }, source: 'create', blocking: 'none', raisedAt: NOW } as const;
  const corner = (g: GlobView) => dom(markup(g)).querySelector('[data-testid="card-corner"]');

  it('shows an open question as the "question" corner status with the human icon, and no question line', () => {
    const root = dom(markup(view({ status: 'planning', questions: [asked] })));
    expect(root.querySelector('[data-testid="question-chip"]')).toBeNull();
    expect(root.textContent).not.toMatch(/Question \d/);
    expect(root.querySelector('[data-testid="card-corner"]')?.textContent).toContain('question');
    expect(root.innerHTML).toContain('Is prod in scope?');
    expect(corner(view({ status: 'planning', questions: [asked, { ...asked, id: 'q2' }] }))?.textContent).toContain('questions');
  });

  it('shows no branch line for a behind or clashing glob', () => {
    const behind = view({ status: 'planning', behind: { base: 'main', behindBy: 2, files: ['a.ts'], at: NOW }, clash: { with: 's1t2', paths: ['a.ts'] } });
    expect(dom(markup(behind)).textContent).not.toMatch(/behind main|clashes with/);
  });
});

describe('environment and deploy labels on the card', () => {
  it('shows no environment, deploy or branch label for a glob deployed to demo and on int', () => {
    const deployed = {
      deploy: { environment: 'demo', state: 'live', sha: 'abc1234def', waiting: false },
      environments: [{ environment: 'int', role: 'integration', production: false, sha: 'abc1234def', since: NOW, warning: 'before_sign_off' }],
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <GlobCard {...base()} {...(deployed as object)} glob={view({ status: 'pr_open', branch: 's1t1' })} repo='a/b' />
      </MemoryRouter>,
    );
    const root = dom(html);
    expect(root.querySelector('[data-testid="deploy-chip"]')).toBeNull();
    expect(root.querySelector('[data-testid="environment-chip"]')).toBeNull();
    expect(html).not.toMatch(/demo|\bint\b|before sign-off/);
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

const planning = (patch: Partial<GlobView> = {}) => view({ type: 'sub', status: 'planning', list: 'planning', ...patch });
const mergeable = (patch: Partial<GlobView> = {}) => prOpen({ list: 'doing', allowedActions: ['merge'], ...patch });
const fixable = (patch: Partial<GlobView> = {}) =>
  prOpen({ type: 'sub', implementer: null, list: 'doing', allowedActions: ['resolve_conflict', 'take_over'], conflict: { base: 'main', files, since: 's1t9', at: NOW }, ...patch });
const bottomLeft = (html: string) => dom(html).querySelector('[data-testid="card-bottom"]')?.firstElementChild ?? null;

describe('card actions: one primary button, bottom left', () => {
  it.each([
    ['Start', () => planning({ allowedActions: ['start'] }), 'move-start'],
    ['Pick up', () => planning({ type: 'super', allowedActions: ['pick_up'] }), 'move-pick_up'],
    ['Merge', () => mergeable(), 'move-merge'],
    ['Fix conflict', () => fixable(), 'move-resolve_conflict'],
  ] as const)('shows %s as the only button, in the bottom-left of the card', (label, make, testId) => {
    const root = dom(markup(make()));
    const buttons = root.querySelectorAll('[data-glob-id] button[data-testid^="move-"]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute('data-testid')).toBe(testId);
    expect(buttons[0]?.textContent).toContain(label);
    const bottom = root.querySelector('[data-testid="card-bottom"]');
    expect(bottom?.firstElementChild?.getAttribute('data-testid')).toBe('card-actions');
    expect(bottom?.firstElementChild?.contains(buttons[0] ?? null)).toBe(true);
    // Nothing action-like sits top right, and the bottom right is only the Arm system label, a dot and the avatar.
    const corner = root.querySelector('[data-testid="card-corner"]');
    expect(corner?.querySelectorAll('button:not([data-testid="position"]):not([data-testid="escalation-chip"])')).toHaveLength(0);
    expect(corner?.querySelector('[data-testid^="move-"]')).toBeNull();
    expect(bottom?.lastElementChild?.querySelector('button[data-testid^="move-"]')).toBeNull();
  });

  it('shows one button for a same that can both Start and be picked up: Start', () => {
    const html = markup(planning({ type: 'same', allowedActions: ['start', 'pick_up'] }));
    expect(html).toContain('data-testid="move-start"');
    expect(html).not.toContain('data-testid="move-pick_up"');
  });

  it('shows no button, and no empty actions row, with a blocker', () => {
    const blockers: Record<string, GlobView> = {
      'unmerged needs': { ...waitingOn(), allowedActions: ['start', 'pick_up'] },
      escalation: planning({ escalation: { reason: 'billing', at: NOW } as GlobView['escalation'], allowedActions: ['start', 'pick_up'] }),
      stall: planning({ provisioning: 'failed', allowedActions: ['start', 'pick_up'] }),
      question: planning({ questions: [{ id: 'q1', text: 'Which table?', raisedBy: { kind: 'intake', actor: null }, source: 'create', blocking: 'start', raisedAt: NOW }], allowedActions: ['start'] }),
    };
    for (const [name, g] of Object.entries(blockers)) {
      const html = markup(g);
      expect(html, name).not.toContain('data-testid="move-');
      expect(html, name).not.toContain('card-actions');
    }
    expect(markup(conflicting())).not.toContain('your-turn-chip');
  });

  it('has no button while the glob is still being given its branch', () => {
    expect(markup(planning({ provisioning: 'pending', allowedActions: ['start'] }))).not.toContain('card-actions');
  });

  it('never shows Retry, Resume, Take over, Cancel merge, Merge anyway, Deploy, Done or Failed… on the card', () => {
    const everything = ['retrigger', 'retry_autofix', 'retry_merge', 'cancel_merge', 'merge_anyway', 'start_anyway', 'mark_ready', 'complete_action', 'fail_action', 'dismiss_action', 'start_again', 'review_now', 'investigate', 'reopen', 'sign_off', 'prepare_action'] as const;
    const globs: readonly GlobView[] = [
      planning({ allowedActions: [...everything] }),
      planning({ type: 'same', allowedActions: [...everything] }),
      mergeable({ allowedActions: [...everything] }),
      prOpen({ list: 'doing', allowedActions: [...everything] }),
      view({ category: 'action', type: null, status: 'planning', list: 'planning', pr: null, allowedActions: ['complete_action', 'fail_action', 'dismiss_action', 'prepare_action'] }),
    ];
    for (const g of globs) {
      const html = markup(g);
      expect(html).not.toMatch(/data-testid="move-/);
      expect(withoutTips(html)).not.toMatch(/\b(Retry|Resume|Take over|Cancel merge|Merge anyway|Deploy|Failed…|Done)\b/);
    }
  });

  it('never offers Pick up for a failed automatic fix, only a status', () => {
    const failedRun = (id: string) => run({ id, state: 'ended', outcome: 'failed', failureReason: 'boom', endedAt: new Date().toISOString() });
    const g = view({
      type: 'sub',
      status: 'failed',
      list: 'doing',
      runs: [failedRun('a'), failedRun('b')],
      currentRun: failedRun('b'),
      failure: { reason: 'The run failed: boom', at: NOW },
      allowedActions: ['pick_up', 'retrigger', 'start_again'],
    });
    const html = markup(g);
    expect(html).not.toContain('move-pick_up');
    expect(html).not.toContain('card-actions');
    expect(dom(html).querySelector('[data-testid="card-status"]')).not.toBeNull();
  });

  it('shows signed off and provisioning failed only in the corner status', () => {
    const signed = markup(view({ status: 'signed_off', signedOffAt: NOW }));
    expect(signed).not.toContain('card-signed-off');
    expect(signed).toContain('data-kind="signed-off"');
    const failed = markup(view({ type: 'same', status: 'planning', provisioning: 'failed' }));
    expect(failed).not.toContain('provisioning-chip');
    expect(failed).toContain('provisioning failed');
  });

  it('says Your turn once, as status: the corner reads Merge and the button is below, not both in the corner', () => {
    const root = dom(markup(mergeable()));
    expect(root.querySelector('[data-testid="card-corner"] [data-testid="position"]')?.textContent).toMatch(/merge/i);
    expect(root.querySelector('[data-testid="card-corner"] [data-testid="move-merge"]')).toBeNull();
    expect(root.querySelector('[data-testid="card-bottom"] [data-testid="move-merge"]')).not.toBeNull();
  });

  it('shows no actions row for a card with nothing to click', () => {
    expect(markup(view({ type: 'same', status: 'planning', allowedActions: [] }))).not.toContain('card-actions');
  });

  it('puts no card-pending label, no loader and no link or action chip anywhere on the card, whatever the state', () => {
    const states = [mergeable(), fixable(), conflicting(), stalledByConflict(), waitingOn(), planning({ allowedActions: ['start'] }), prOpen({ allowedActions: [], headChecks: { sha: head, state: 'failed' } })];
    for (const g of states) {
      const html = markup(g);
      expect(html).not.toContain('card-pending');
      expect(html).not.toContain('animate-spin" aria-hidden');
      expect(dom(html).querySelector('a[href^="http"]')).toBeNull();
      expect(dom(html).querySelector('[data-testid="draft-chip"], [data-testid="atf-chip"], [data-testid="action-chip"], [data-testid="label-popover"]')).toBeNull();
    }
  });
});

describe('card in progress: after a click', () => {
  const statusText = (root: HTMLElement) => root.querySelector('[data-testid="card-status"] .truncate')?.textContent;

  it.each([
    ['Merge', () => mergeable(), 'merge', 'merging'],
    ['Fix conflict', () => fixable(), 'resolve_conflict', 'fixing the conflict'],
    ['Start', () => planning({ allowedActions: ['start'] }), 'start', 'starting'],
  ] as const)('%s: the button is gone, the status says what is happening, and nothing is left bottom left', (_name, make, action, text) => {
    const g = make();
    const root = dom(
      renderToStaticMarkup(
        <MemoryRouter>
          <GlobCard {...base()} glob={g} repo='a/b' pending={clickOf(action, 'dev@example.com')} />
        </MemoryRouter>,
      ),
    );
    expect(root.querySelector('[data-testid^="move-"]')).toBeNull();
    expect(root.querySelector('[data-testid="card-actions"]')).toBeNull();
    expect(root.querySelector('[data-testid="card-pending"]')).toBeNull();
    const status = root.querySelector('[data-testid="card-status"]');
    expect(statusText(root)).toBe(text);
    expect(status?.getAttribute('data-icon')).toBe('machine-spinning');
    expect(root.querySelector('[data-testid="card-corner"] svg.animate-spin')).not.toBeNull();
    // The bottom row holds only the Arm system label, a dot and the avatar: no text, loader or label for the click.
    const bottom = root.querySelector('[data-testid="card-bottom"]');
    expect(bottom?.textContent).not.toMatch(/Merging|Fixing|Starting|…/);
    expect(bottom?.querySelector('svg.animate-spin')).toBeNull();
  });

  it('shows the stored pending click the same way, after a refresh', () => {
    const g = mergeable({ pendingAction: { kind: 'merge', at: new Date().toISOString(), by: 'dev@example.com' } });
    const root = dom(markup(g));
    expect(root.querySelector('[data-testid="move-merge"]')).toBeNull();
    expect(statusText(root)).toBe('merging');
  });

  it('gives the button back once the click has timed out with nothing to show for it', () => {
    const g = mergeable({ pendingAction: { kind: 'merge', at: new Date(Date.now() - 120_000).toISOString(), by: 'dev@example.com' } });
    expect(dom(markup(g)).querySelector('[data-testid="move-merge"]')).not.toBeNull();
  });

  it('marks the card busy only while a click is pending', () => {
    expect(dom(markup(mergeable())).querySelector('[data-glob-id]')?.getAttribute('aria-busy')).toBe('false');
    const pending = mergeable({ pendingAction: { kind: 'merge', at: new Date().toISOString(), by: 'dev@example.com' } });
    expect(dom(markup(pending)).querySelector('[data-glob-id]')?.getAttribute('aria-busy')).toBe('true');
  });
});

describe('the merged globs, in line with the layout rules', () => {
  it('s15t217: a Fix conflict click shows "fixing the conflict" top right, never a "Fixing conflict…" label in the actions area', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <GlobCard {...base()} glob={fixable()} repo='a/b' pending={clickOf('resolve_conflict', 'dev@example.com')} />
      </MemoryRouter>,
    );
    expect(html).not.toContain('Fixing conflict…');
    expect(dom(html).querySelector('[data-testid="card-corner"]')?.textContent).toContain('fixing the conflict');
  });

  it('s15b158: Merge is a bottom-left button, its confirm label is on the button only, and no pending label follows the click', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(
      <MemoryRouter>
        <GlobCard {...base()} onMove={onMove} glob={mergeable()} repo='a/b' />
      </MemoryRouter>,
    );
    const button = screen.getByTestId('move-merge');
    expect(screen.getByTestId('card-bottom').firstElementChild?.contains(button)).toBe(true);
    await user.click(button);
    expect(button.textContent).toBe('Confirm merge');
    expect(screen.getAllByText(/confirm/i)).toHaveLength(1);
    expect(screen.queryByTestId('card-pending')).toBeNull();
    await user.click(button);
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ action: 'merge' }));
    expect(screen.queryByTestId('card-pending')).toBeNull();
  });

  it('s15b158: the confirming tooltip says what the second click does: Merge lands the PR, Fix conflict starts a run', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <GlobCard {...base()} glob={mergeable()} repo='a/b' />
      </MemoryRouter>,
    );
    await user.click(screen.getByTestId('move-merge'));
    expect(screen.getByTestId('move-merge').getAttribute('aria-label')).toContain('Click again to merge');
    expect(screen.getByTestId('move-merge').getAttribute('aria-label')).not.toContain('conflict-fix');
    cleanup();
    render(
      <MemoryRouter>
        <GlobCard {...base()} glob={fixable()} repo='a/b' />
      </MemoryRouter>,
    );
    await user.click(screen.getByTestId('move-resolve_conflict'));
    expect(screen.getByTestId('move-resolve_conflict').getAttribute('aria-label')).toContain('Click again to start a conflict-fix run');
  });

  it("s15t238: preparing, ready to run and recording are the status top right; Done and Failed… are not card buttons", () => {
    const prepared = (actionState: GlobView['actionState'], patch: Partial<GlobView> = {}) =>
      view({ category: 'action', type: null, pr: null, status: 'planning', list: 'planning', actionState, preparation: { record: 'branch', rounds: 1 }, allowedActions: ['complete_action', 'fail_action', 'dismiss_action'], ...patch });
    const html = markup(prepared('ready'));
    const ready = dom(html);
    expect(ready.querySelector('[data-testid="card-status"] .truncate')?.textContent).toBe('ready to run');
    expect(ready.querySelector('[data-testid^="move-"]')).toBeNull();
    expect(withoutTips(html)).not.toMatch(/Done|Failed…/);
  });

  it('s15t219: a super in Planning has Pick up bottom left, and the sstor copy notice is never on the card', () => {
    const html = markup(planning({ type: 'super', allowedActions: ['pick_up'] }));
    expect(bottomLeft(html)?.querySelector('[data-testid="move-pick_up"]')).not.toBeNull();
    expect(withoutTips(html)).not.toMatch(/sstor|copied/i);
  });

  it('s15t240: an open question is the "question" status with the human icon, and nowhere else on the card', () => {
    const asked = { id: 'q1', text: 'Is prod in scope?', raisedBy: { kind: 'intake', actor: null }, source: 'create', blocking: 'start', raisedAt: NOW } as const;
    const root = dom(markup(planning({ questions: [asked], allowedActions: ['start'] })));
    expect(root.querySelector('[data-testid="card-status"]')?.getAttribute('data-icon')).toBe('human');
    expect(root.querySelector('[data-testid="card-status"] .truncate')?.textContent).toBe('question');
    expect(withoutTips(markup(planning({ questions: [asked] })))).not.toMatch(/Is prod in scope/);
    expect(root.querySelector('[data-testid^="move-"]')).toBeNull();
  });
});

describe('card interaction', () => {
  const renderCard = (g: GlobView, extra: Partial<Parameters<typeof GlobCard>[0]> = {}) => {
    const props = base();
    render(
      <MemoryRouter>
        <GlobCard {...props} glob={g} repo='a/b' {...extra} />
      </MemoryRouter>,
    );
    return props;
  };

  it('filters to the group when its tag is clicked, without opening the card', async () => {
    const user = userEvent.setup();
    const onFilterGroup = vi.fn();
    const { onOpen } = renderCard(view({ group: 'glob-groups' }), { onFilterGroup });
    await user.click(screen.getByTestId('group-chip'));
    expect(onFilterGroup).toHaveBeenCalledWith('glob-groups');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows a grouped glob as one tag that filters, never a link to the group page', () => {
    renderCard(view({ group: 'glob-groups' }), { onFilterGroup: vi.fn() });
    expect(screen.queryByTestId('group-filter')).toBeNull();
    const tag = screen.getByTestId('group-chip');
    expect(tag.getAttribute('href')).toBeNull();
    expect(tag.textContent).toBe('glob-groups');
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

  it('the corner is status only: its click opens the glob view at a section and never runs Merge', async () => {
    const user = userEvent.setup();
    const { onMove, onOpen, onOpenSection } = renderCard(mergeable());
    expect(screen.getByTestId('position').textContent).toBe('Merge');
    await user.click(screen.getByTestId('position'));
    expect(onMove).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onOpenSection).toHaveBeenCalledTimes(1);
  });

  describe('Merge button', () => {
    const withMerge = (g = mergeable()) => {
      const out = renderCard(g);
      return { ...out, button: () => screen.getByTestId('move-merge') };
    };

    it('reads Merge, with or without rollout steps, and says what follows in its tip', () => {
      expect(withMerge().button().textContent).toBe('Merge');
      cleanup();
      const { button } = withMerge(mergeable({ rolloutSteps: 2 }));
      expect(button().textContent).toBe('Merge');
      expect(button().getAttribute('aria-label')).toContain("Then run its 2 rollout steps (it stays open until they're done)");
    });

    it('the first click only arms it; the second runs it, never opening the card', async () => {
      const user = userEvent.setup();
      const { button, onMove, onOpen } = withMerge();
      await user.click(button());
      expect(button().textContent).toBe('Confirm merge');
      expect(onMove).not.toHaveBeenCalled();
      await user.click(button());
      expect(onMove).toHaveBeenCalledTimes(1);
      expect(onMove.mock.calls[0]?.[0]).toMatchObject({ action: 'merge' });
      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe('Fix conflict button', () => {
    const withFix = (extra: Partial<Parameters<typeof GlobCard>[0]> = {}) => {
      const out = renderCard(fixable(), extra);
      return { ...out, button: () => screen.getByTestId('move-resolve_conflict') };
    };

    it('shows a primary Fix conflict on a conflicting glob in Doing, with no arrow', () => {
      const { button } = withFix();
      expect(button().textContent).toBe('Fix conflict');
      expect(button().className).toContain('bg-primary');
    });

    it('the first click only arms it; the second runs it', async () => {
      const user = userEvent.setup();
      const { button, onMove, onOpen } = withFix();
      await user.click(button());
      expect(button().textContent).toBe('Confirm fix conflict');
      expect(button().getAttribute('data-confirming')).toBe('true');
      expect(onMove).not.toHaveBeenCalled();
      await user.click(button());
      expect(onMove).toHaveBeenCalledTimes(1);
      expect(onMove.mock.calls[0]?.[0]).toMatchObject({ action: 'resolve_conflict' });
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('reverts on Escape and on blur, and runs nothing', async () => {
      const user = userEvent.setup();
      const { button, onMove } = withFix();
      await user.click(button());
      await user.keyboard('{Escape}');
      expect(button().textContent).toBe('Fix conflict');
      await user.click(button());
      expect(button().textContent).toBe('Confirm fix conflict');
      await user.tab();
      expect(button().textContent).toBe('Fix conflict');
      expect(onMove).not.toHaveBeenCalled();
    });

    it('reverts after the timeout', () => {
      vi.useFakeTimers();
      try {
        const { button } = withFix();
        act(() => button().click());
        expect(button().textContent).toBe('Confirm fix conflict');
        act(() => void vi.advanceTimersByTime(CONFIRM_MS + 1));
        expect(button().textContent).toBe('Fix conflict');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('opens the glob view from a ready status that needs input, without running anything', async () => {
    const user = userEvent.setup();
    const g = prOpen({ allowedActions: [] });
    const { onOpenSection, onOpen, onMove } = renderCard(g);
    await user.click(screen.getByTestId('position'));
    expect(onOpenSection).toHaveBeenCalledWith({ section: 'actions' });
    expect(onMove).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens the glob view at the section from the status without running anything', async () => {
    const user = userEvent.setup();
    const { onOpenSection, onOpen, onMove } = renderCard(conflicting());
    await user.click(screen.getByTestId('position'));
    expect(onOpenSection).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
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

describe('card indicators: what holds the glob, workstreams, rollout and Arm system', () => {
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
  const corner = (g: GlobView) => {
    const root = dom(markup(g));
    const el = root.querySelector('[data-testid="card-status"]');
    return { el, text: el?.querySelector('.truncate')?.textContent ?? null, icon: el?.getAttribute('data-icon') ?? null, html: markup(g) };
  };
  const step = (patch: Partial<NonNullable<GlobView['humanSteps']>[number]> = {}): NonNullable<GlobView['humanSteps']>[number] => ({
    id: 'hs_1',
    kind: 'rollout',
    title: 'Run the migration',
    state: 'pending',
    who: 'admin',
    due: 'after_merge',
    blocks: ['sign_off', 'dependants'],
    ...patch,
  });
  const mergedWith = (steps: NonNullable<GlobView['humanSteps']>, patch: Partial<GlobView> = {}) =>
    view({ status: 'reviewing', pr: { number: 7, state: 'merged', headSha: head }, humanSteps: steps, labels: { QA: 'required' }, ...patch });
  type Item = readonly [name: string, state: WorkstreamState, conflicts?: readonly string[]];
  const ws = (items: readonly Item[]): WorkstreamsSummary => ({ fannedOut: true, items: items.map(([name, state, conflicts]) => ({ name, state, conflicts: conflicts ?? [] })) });

  it('a hold by a decision says so with the human icon, and a hold by a glob with the hourglass', () => {
    const decision = corner(view({ status: 'planning', holding: [hold('s1k1', { toIsDecision: true, until: 'decided', state: 'planning', reason: 'store not chosen' })] }));
    expect(decision).toMatchObject({ text: 'waiting · decision s1k1', icon: 'human' });
    expect(decision.html).toContain('store not chosen');
    expect(corner(view({ status: 'planning', holding: [hold('s1t1')] }))).toMatchObject({ text: 'waiting · s1t1', icon: 'hourglass' });
  });

  it('a merge gate says "merge held" and several holds are the first plus the others', () => {
    const g = view({ status: 'pr_open', pr: { number: 1, state: 'draft', headSha: head }, holding: [hold('s1k1', { gate: 'merge', toIsDecision: true, until: 'decided', state: 'planning' })] });
    expect(corner(g)).toMatchObject({ text: 'merge held · decision s1k1', icon: 'human' });
    expect(corner(view({ status: 'planning', holding: [hold('s1t1'), hold('s1t2'), hold('s1t3')] })).text).toBe('waiting · s1t1 +2');
  });

  it('the tooltip lists every hold with its reason, and a click opens the Related section', async () => {
    const holding = [hold('s1t1', { reason: 'uses its store' }), hold('s1t2', { state: 'planning', reason: 'same file' })];
    const html = markup(view({ status: 'planning', holding }));
    expect(html).toContain('Waits for s1t1 to be merged and rolled out (Doing): uses its store');
    expect(html).toContain('Waits for s1t2 to be merged and rolled out (Planning): same file');
    const user = userEvent.setup();
    const onOpenSection = vi.fn();
    render(
      <MemoryRouter>
        <GlobCard {...base()} onOpenSection={onOpenSection} glob={view({ status: 'planning', holding })} repo='a/b' />
      </MemoryRouter>,
    );
    await user.click(screen.getByTestId('position'));
    expect(onOpenSection).toHaveBeenCalledWith({ section: 'related' });
  });

  const states: readonly (readonly [string, readonly Item[], string, string])[] = [
    ['working', [['W0', 'done'], ['W1', 'running'], ['W2', 'not_started']], 'working · 1/3 workstreams', 'machine-spinning'],
    ['waiting for a decision', [['W1', 'done'], ['W2', 'waiting_decision']], 'waiting · decision for W2', 'human'],
    ['failed', [['W1', 'done'], ['W3', 'failed']], 'failed · W3', 'human'],
    ['an integration conflict', [['W1', 'running', ['a.ts']], ['W2', 'running', ['b.ts']]], 'integration conflict · W1+W2', 'machine-spinning'],
  ];
  it.each(states)('workstream state, %s', (_name, items, text, icon) => {
    const fresh = new Date().toISOString();
    const r = run({ state: 'active', queuedAt: fresh, startedAt: fresh, lastProgressAt: fresh });
    const g = view({ status: 'in_progress', runs: [r], currentRun: r, workstreams: ws(items) });
    expect(corner(g)).toMatchObject({ text, icon });
  });

  it('workstream states show only while the glob is being built, not once merged', () => {
    expect(corner(mergedWith([], { workstreams: ws([['W1', 'running']]) })).text).toBe('sign off');
  });

  it('rollout replaces sign off with the human icon, with no upcoming-steps chip lower on the card', () => {
    const g = mergedWith([step({ id: 'a', state: 'done' }), step({ id: 'b' }), step({ id: 'c', state: 'pending' })]);
    expect(corner(g)).toMatchObject({ text: 'do', icon: 'human' });
    expect(dom(markup(g)).querySelector('[data-testid="upcoming-steps-chip"]')).toBeNull();
  });

  it('rollout opens the human steps, and the corner returns to sign off, then signed off, when the rollout is done', async () => {
    const user = userEvent.setup();
    const onOpenSection = vi.fn();
    render(
      <MemoryRouter>
        <GlobCard {...base()} onOpenSection={onOpenSection} glob={mergedWith([step({ state: 'due' })])} repo='a/b' />
      </MemoryRouter>,
    );
    await user.click(screen.getByTestId('position'));
    expect(onOpenSection).toHaveBeenCalledWith({ section: 'human-steps' });
    const done = mergedWith([step({ state: 'done' })]);
    expect(corner(done)).toMatchObject({ text: 'sign off', icon: 'human' });
    expect(corner(mergedWith([step({ state: 'done' })], { status: 'signed_off', labels: { QA: 'approved' } })).text).toBe('signed off');
  });

  it('the Arm system label shows for a written rollout or an after_merge step, from Planning on, and not for a prediction or a done step', () => {
    const label = (g: GlobView) => dom(markup(g)).querySelector('[data-testid="arm-system-label"]');
    expect(label(view({ status: 'planning', humanSteps: [step()] }))?.textContent).toBe('Arm system');
    expect(label(view({ status: 'in_progress', humanSteps: [step({ kind: 'upload_file', title: 'Add the key' })] }))).not.toBeNull();
    expect(label(view({ status: 'planning', humanSteps: [step({ predicted: true })] }))).toBeNull();
    expect(label(view({ status: 'reviewing', humanSteps: [step({ state: 'done' })] }))).toBeNull();
    expect(label(view({ status: 'planning', humanSteps: [] }))).toBeNull();
  });

  it('the Arm system label is always plain, stays after sign-off, and its tooltip is the first open step', () => {
    const label = (g: GlobView) => dom(markup(g)).querySelector('[data-testid="arm-system-label"]');
    const main = view({ status: 'reviewing', humanSteps: [step()], arm: { title: 'Run the **migration**' } });
    expect(label(main)?.textContent).toBe('Arm system');
    const prod = view({ status: 'signed_off', humanSteps: [step()], arm: { title: 'Roll out the host stack' } });
    expect(label(prod)?.textContent).toBe('Arm system');
    expect(armLabel(prod)?.tip).toBe('Roll out the host stack');
    expect(armLabel(view({ humanSteps: [step()] }))).toMatchObject({ text: 'Arm system' });
    expect(armLabel(main)).toEqual({ text: 'Arm system', tip: 'Run the migration' });
    expect(label(view({ status: 'signed_off', humanSteps: [] }))).toBeNull();
  });

  it('a signed-off glob with only an open downstream step shows plain Arm system, and none once it is ticked', () => {
    const label = (g: GlobView) => dom(markup(g)).querySelector('[data-testid="arm-system-label"]');
    const downstream = (state: 'due' | 'done') => step({ id: 'hs_d', due: 'downstream', blocks: [], state });
    expect(label(view({ status: 'signed_off', humanSteps: [downstream('due')] }))?.textContent).toBe('Arm system');
    expect(label(view({ status: 'signed_off', humanSteps: [downstream('done')] }))).toBeNull();
  });

  it('the Arm system label is a rocket and text in the primary action colour, at the bottom right beside the avatar, with its tooltip', () => {
    const html = markup(view({ status: 'planning', humanSteps: [step()] }));
    const root = dom(html);
    const el = root.querySelector('[data-testid="arm-system-label"]');
    expect(el?.className).toContain('text-primary');
    expect(el?.className).not.toMatch(/text-red|text-signal/);
    expect(el?.querySelector('svg.lucide-rocket')).not.toBeNull();
    expect(root.querySelector('[data-testid="card-bottom"]')?.lastElementChild?.contains(el ?? null)).toBe(true);
    expect(html).toContain('A person has a step at release: Run the migration');
    // The primary action's button uses the same token.
    expect(markup(planning({ allowedActions: ['start'] }))).toContain('bg-primary');
  });

  it('the Arm system label has a dot after it, before the avatar, in normal weight, and only with the label', () => {
    const arm = (g: GlobView) => dom(markup(g)).querySelector('[data-testid="card-arm-separator"]');
    const withStep = dom(markup(view({ status: 'planning', humanSteps: [step()] })));
    const label = withStep.querySelector('[data-testid="arm-system-label"]');
    expect(label?.className).not.toContain('font-semibold');
    const dot = withStep.querySelector('[data-testid="card-arm-separator"]');
    expect(dot?.previousElementSibling?.contains(label ?? null)).toBe(true);
    expect(arm(view({ status: 'planning', humanSteps: [] }))).toBeNull();
  });

  it('clicking the Arm system label opens the glob at Human steps without opening the card or filtering', async () => {
    const user = userEvent.setup();
    const onOpenSection = vi.fn();
    const onOpen = vi.fn();
    render(
      <MemoryRouter>
        <GlobCard {...base()} onOpen={onOpen} onOpenSection={onOpenSection} glob={view({ status: 'planning', humanSteps: [step()] })} repo='a/b' />
      </MemoryRouter>,
    );
    await user.click(screen.getByTestId('arm-system-label'));
    expect(onOpenSection).toHaveBeenCalledWith({ section: 'human-steps' });
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('an action glob card', () => {
  const action = (patch: Partial<GlobView> = {}): GlobView =>
    view({ id: 's1a1', category: 'action', type: null, pr: null, attributes: { assignee: null, outcome: null }, ...patch });

  it('shows the running person and the category word instead of a type', () => {
    const root = dom(markup(action({ attributes: { assignee: 'sam@example.com', outcome: null } })));
    expect(root.querySelector('[data-testid="card-type"]')?.textContent).toBe('action');
    const icon = root.querySelector('[data-testid="card-corner"] [role="img"]');
    expect(icon?.getAttribute('data-icon')).toBe('person-running');
    expect(icon?.getAttribute('aria-label')).toBe('action');
    expect(root.querySelector('[data-testid="card-corner"] svg.lucide-user-round')).toBeNull();
    // Who is meant to do it is the glob view's chip, not the card's.
    expect(root.querySelector('[data-testid="action-chip"]')).toBeNull();
    expect(root.querySelector('[data-testid="card-corner-separator"]')).toBeNull();
  });

  describe('prepared', () => {
    const prepared = (patch: Partial<GlobView>, rounds = 1) =>
      action({ attributes: { assignee: null, outcome: null, preparation: { record: 'branch', rounds } }, ...patch });
    const corner = (g: GlobView) => dom(markup(g)).querySelector('[data-testid="card-corner"]');
    const statusText = (g: GlobView) => corner(g)?.querySelector('.truncate')?.textContent;

    it('shows the machine spinning while it prepares', () => {
      const g = prepared({ status: 'implementing', actionState: 'preparing' });
      expect(statusText(g)).toBe('preparing');
      expect(corner(g)?.querySelector('svg.lucide-bot')?.getAttribute('class')).toContain('animate-spin');
    });

    it('shows a person with ready to run', () => {
      const g = prepared({ status: 'pr_open', actionState: 'ready', pr: { number: 7, state: 'ready', headSha: head }, headChecks: { sha: head, state: 'passed' } });
      expect(statusText(g)).toBe('ready to run');
      expect(corner(g)?.querySelector('svg.lucide-user-round')).not.toBeNull();
    });

    it('shows recording once Done is recorded and the branch merges', () => {
      const g = prepared({
        status: 'merging',
        actionState: 'recording',
        pr: { number: 7, state: 'ready', headSha: head },
        headChecks: { sha: head, state: 'passed' },
        attributes: { assignee: null, outcome: { kind: 'done', by: 'a@b.c', at: NOW }, preparation: { record: 'branch', rounds: 1 } },
      });
      expect(statusText(g)).toMatch(/^recording/);
    });

    it('shows a failed preparation in red text', () => {
      const g = prepared({ status: 'failed', actionState: 'preparation_failed', failure: { reason: 'timed out', at: NOW } });
      expect(statusText(g)).toContain('Preparation failed');
    });
  });

  it('writes the mode beside the ID and shows a kind icon on every card', () => {
    const icon = (g: GlobView) => dom(markup(g)).querySelector('[data-testid="card-corner"] [role="img"]');
    const plain = dom(markup(view({ category: 'feature', type: 'sub' })));
    expect(plain.querySelector('[data-testid="card-type"]')?.textContent).toBe('sub');
    expect(icon(view({ category: 'feature', type: 'sub' }))?.getAttribute('aria-label')).toBe('feature');
    expect(icon(view({ category: 'feature', type: 'sub' }))?.getAttribute('class')).toContain('lucide-sparkles');
    expect(icon(view({ category: 'task', type: 'sub', workKind: 'maintenance' }))?.getAttribute('class')).toContain('lucide-list-checks');
    expect(icon(view({ category: 'task', type: 'super' }))?.getAttribute('aria-label')).toBe('task');
    const fix = dom(markup(view({ category: 'task', type: 'same', fix: true })));
    expect(fix.querySelector('[data-testid="card-type"]')?.textContent).toBe('same');
    expect(fix.querySelector('[data-testid="card-corner"] [role="img"]')?.getAttribute('aria-label')).toBe('bug');
    expect(fix.querySelector('[data-testid="card-corner"] [role="img"]')?.getAttribute('class')).toContain('text-red');
    // The stored flag wins over the old category.
    expect(icon(view({ category: 'bug', type: 'same', fix: false }))?.getAttribute('aria-label')).toBe('task');
  });

  it('shows the scale for a decision and a dot before it', () => {
    const decision = dom(markup(view({ id: 's1k1', category: 'decision', type: null, pr: null })));
    const icon = decision.querySelector('[data-testid="card-corner"] [role="img"]');
    expect(icon?.getAttribute('aria-label')).toBe('decision');
    expect(icon?.getAttribute('class')).toContain('lucide-scale');
  });

  it('puts a dot before the kind icon after a status, and shows the icon alone without one', () => {
    const calm = dom(markup(view({ status: 'planning', category: 'feature' })));
    expect(calm.querySelector('[data-testid="card-corner"] [role="img"]')).not.toBeNull();
    expect(calm.querySelector('[data-testid="card-corner-separator"]')).toBeNull();
    const busy = dom(markup(stalledByConflict()));
    expect(busy.querySelector('[data-testid="card-corner-separator"]')).not.toBeNull();
  });

  it('shows a decision with its category word, not a type', () => {
    const decision = view({ id: 's1k1', category: 'decision', type: null, pr: null });
    expect(dom(markup(decision)).querySelector('[data-testid="card-type"]')?.textContent).toBe('decision');
  });

  it('gives a learning no scope, outcome or conflict tags; a decided one reads its outcome in the corner', () => {
    const learning = view({
      id: 's1k1',
      category: 'decision',
      type: null,
      pr: null,
      attributes: { scope: { kind: 'project', ref: null }, outcome: { kind: 'accept', by: 'a@b.c', at: NOW }, conflictsWith: ['s1k2'] },
    } as unknown as Partial<GlobView>);
    const root = dom(markup(learning));
    for (const id of ['scope-chip', 'outcome-chip', 'conflict-chip']) expect(root.querySelector(`[data-testid="${id}"]`)).toBeNull();
    expect(root.querySelector('[data-testid="card-corner"]')?.textContent).toContain('accepted');
    expect(root.textContent).not.toContain('conflicts with');
  });
});
