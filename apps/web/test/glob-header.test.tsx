// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobHeader, HEADER_HEIGHT_VAR } from '../src/components/glob-view/header';
import type { GlobViewContext } from '../src/components/glob-view/context';
import type { GlobActionsState } from '../src/components/glob-view/actions';
import { ACTIVITY_ID, useNowState } from '../src/components/glob-view/status';
import type { GlobView } from '../src/lib/api';
import { GlobCard } from '../src/components/glob-card';
import { NOW, glob, run } from '../../../packages/core/test/fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GlobHeader', () => {
  const renderBar = (g: GlobView, setup?: () => void, viewer?: { email: string; role: 'admin' }, base?: string) => {
    setup?.();
    const ctx = { glob: g, onUpdate: () => Promise.resolve(null) } as unknown as GlobViewContext;
    const Bar = () => {
      const state = useNowState(g, false, [], { viewer, base } as unknown as GlobActionsState);
      return <GlobHeader ctx={ctx} onClose={() => undefined} state={state} />;
    };
    return render(
      <MemoryRouter>
        <article>
          <Bar />
        </article>
      </MemoryRouter>,
    );
  };
  const view = (over: Partial<GlobView> = {}): GlobView => ({ ...glob(), boardId: 1, branch: 's1t1', ...over }) as GlobView;

  it('holds only the back arrow, the ID with its list, and the status: no title, branch or version', () => {
    const { getByTestId } = renderBar(view({ title: 'A very long title that would wrap', version: 7, status: 'merging', pr: { number: 7, state: 'ready', headSha: 'abc' } }));
    const bar = getByTestId('glob-header');
    expect(getByTestId('glob-back')).toBeTruthy();
    expect(getByTestId('glob-id').textContent).toBe(view().id);
    expect(getByTestId('header-status').textContent).toBeTruthy();
    expect(bar.textContent).not.toContain('A very long title');
    expect(bar.textContent).not.toContain('Now:');
    expect(bar.textContent).not.toMatch(/branch|v7/);
  });

  it('uses compact padding and line-height with no fixed height', () => {
    const { getByTestId } = renderBar(view());
    const cls = getByTestId('glob-header').className;
    expect(cls).toMatch(/\bpy-1\b/);
    expect(cls).toContain('leading-5');
    expect(cls).toContain('items-center');
    expect(cls).not.toMatch(/\b(h-\d+|min-h-\S+)\b/);
    expect(cls).not.toMatch(/(^|\s)mb-/);
    expect(getByTestId('glob-back').className).toContain('p-1.5');
  });

  it('scrolls to the Activity log when the status is clicked', () => {
    const { getByTestId } = renderBar(view({ status: 'merging', pr: { number: 7, state: 'ready', headSha: 'abc' } }));
    const target = document.createElement('div');
    target.id = ACTIVITY_ID;
    const scrollIntoView = vi.fn();
    Object.defineProperty(target, 'scrollIntoView', { value: scrollIntoView });
    document.body.append(target);
    getByTestId('header-status').click();
    expect(scrollIntoView).toHaveBeenCalled();
    target.remove();
  });

  describe('a live run', () => {
    const live = (sessionUrl: string | null): GlobView =>
      view({
        status: 'implementing',
        currentRun: { ...run(), state: 'active', outcome: null, endedAt: null, sessionUrl },
        machineSteps: [{ id: 'm1', kind: 'implement', state: 'running', startedAt: NOW, lastProgressAt: NOW, detail: null, holdsBall: true }],
        move: { holder: 'machine', reason: 'implementing', since: NOW },
      });

    it("opens the run's session from the status, with the tooltip saying so", () => {
      const open = vi.fn();
      vi.stubGlobal('open', open);
      const { getByTestId } = renderBar(live('https://claude.ai/code/s'));
      expect(getByTestId('header-status').getAttribute('title')).toBe("Open the machine's session");
      getByTestId('header-status').click();
      expect(open).toHaveBeenCalledWith('https://claude.ai/code/s', '_blank', 'noreferrer');
    });

    it('scrolls to the Activity log when the run has no session yet', () => {
      const open = vi.fn();
      vi.stubGlobal('open', open);
      const { getByTestId } = renderBar(live(null));
      expect(getByTestId('header-status').getAttribute('title')).not.toBe("Open the machine's session");
      getByTestId('header-status').click();
      expect(open).not.toHaveBeenCalled();
    });
  });

  it("publishes the bar's measured height on the page", () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => 40);
    const { getByTestId } = renderBar(view());
    const page = getByTestId('glob-header').parentElement as HTMLElement;
    expect(page.style.getPropertyValue(HEADER_HEIGHT_VAR)).toBe('40px');
    });

  describe('the same status as the card', () => {
    const fresh = new Date().toISOString();
    const live = (state: 'queued' | 'active' | 'watching') => {
      const r = run({ state, queuedAt: fresh, startedAt: fresh, lastProgressAt: fresh });
      return { runs: [r], currentRun: r };
    };
    const head = 'd16d563aaaa';
    const prOpen = (over: Partial<GlobView> = {}) =>
      view({ type: 'same', status: 'pr_open', pr: { number: 289, state: 'ready', headSha: head }, headChecks: { sha: head, state: 'passed' }, ...over });
    const files = ['apps/web/src/pages/board.tsx'];
    const cases: readonly [string, () => GlobView][] = [
      ['machine running', () => view({ status: 'in_progress', ...live('active') })],
      ['queued', () => view({ status: 'in_progress', ...live('queued') })],
      ['stalled', () => view({ status: 'failed', failure: { reason: 'Merge conflict with main in a.ts', at: NOW, kind: 'merge', conflict: { base: 'main', files } } })],
      ['your turn', () => prOpen({ allowedActions: ['merge'] })],
      ['prerequisites', () => view({ status: 'planning', holding: [{ relationId: 'rel_1', to: 's1t1', toTitle: null, toIsDecision: false, gate: 'start', until: 'merged', state: 'open', reason: null, source: 'person' }] })],
      ['workstreams', () => view({ status: 'in_progress', ...live('active'), workstreams: { fannedOut: true, items: [{ name: 'W1', state: 'done', conflicts: [] }, { name: 'W2', state: 'waiting_decision', conflicts: [] }] } })],
      ['a merged glob whose deploy is still running', () => view({ status: 'reviewing', labels: { QA: 'required' }, pr: { number: 7, state: 'merged', headSha: head }, machineSteps: [{ id: 'm1', kind: 'deploy', state: 'running', startedAt: NOW, lastProgressAt: NOW, detail: 'prod', holdsBall: false }], humanSteps: [{ id: 'hs_1', kind: 'rollout', title: 'Run it', state: 'pending', who: 'admin', due: 'after_merge', blocks: ['sign_off'] }] })],
      ['a merge hold', () => view({ status: 'pr_open', pr: { number: 1, state: 'draft', headSha: head }, holding: [{ relationId: 'rel_1', to: 's1k1', toTitle: null, toIsDecision: true, gate: 'merge', until: 'decided', state: 'planning', reason: null, source: 'person' }] })],
      ['running checks', () => prOpen({ headChecks: { sha: head, state: 'pending' }, ...live('watching') })],
      ['checks running on a ready sub', () => prOpen({ type: 'sub', headChecks: { sha: head, state: 'pending' } })],
      ['checks running on a same awaiting merge', () => prOpen({ headChecks: { sha: head, state: 'pending' }, allowedActions: ['merge'] })],
      ['checks running on a draft', () => prOpen({ pr: { number: 289, state: 'draft', headSha: head }, headChecks: { sha: head, state: 'pending' } })],
      ['a problem', () => prOpen({ conflict: { base: 'main', files, since: 's1t9', at: NOW } })],
    ];
    it('orders the header corner: text, then the status icon, then the kind marker, and lets the text truncate', () => {
      const { getByTestId } = renderBar(view({ category: 'bug', status: 'in_progress', ...live('active') }));
      const corner = getByTestId('header-corner');
      const button = getByTestId('header-status');
      expect(corner.firstElementChild).toBe(button);
      expect(button.firstElementChild?.getAttribute('data-testid')).toBe('header-status-text');
      expect(button.firstElementChild?.className).toContain('truncate');
      expect(button.lastElementChild?.tagName.toLowerCase()).toBe('svg');
      expect(corner.lastElementChild?.getAttribute('role') ?? corner.lastElementChild?.querySelector('[role="img"]')?.getAttribute('role')).toBe('img');
      expect(getByTestId('glob-id').className).toContain('shrink-0');
    });

    it('puts a dot between the status and the kind marker', () => {
      const { getByTestId } = renderBar(view({ category: 'bug', status: 'in_progress', ...live('active') }));
      const corner = getByTestId('header-corner');
      expect(corner.children).toHaveLength(3);
      expect(corner.children[1]?.getAttribute('data-testid')).toBe('header-dot');
    });

    it('shows a dot and the task icon after the status of machine work that is not a fix', () => {
      const { getByTestId } = renderBar(view({ category: 'task', status: 'in_progress', ...live('active') }));
      const corner = getByTestId('header-corner');
      expect(corner.children).toHaveLength(3);
      expect(corner.children[1]?.getAttribute('data-testid')).toBe('header-dot');
      expect(corner.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('task');
    });

    it.each([
      ['a feature', { category: 'feature', type: 'same' }, 'task', 'lucide-list-checks'],
      ['a task', { category: 'task', type: 'super' }, 'task', 'lucide-list-checks'],
      ['a bug', { category: 'bug', type: 'same' }, 'bug', 'lucide-bug'],
      ['a decision', { category: 'decision', type: null }, 'decision', 'lucide-scale'],
    ] as const)('shows the %s kind icon in the header', (_n, patch, label, cls) => {
      const { getByTestId } = renderBar(view({ ...patch, status: 'planning', list: 'planning' }));
      const icon = getByTestId('header-corner').querySelector('[role="img"]');
      expect(icon?.getAttribute('aria-label')).toBe(label);
      expect(icon?.getAttribute('class')).toContain(cls);
    });

    it('shows the running person, not the person icon, for an action', () => {
      const { getByTestId } = renderBar(view({ category: 'action', type: null, status: 'planning', list: 'planning' }));
      const corner = getByTestId('header-corner');
      expect(corner.querySelector('[data-icon="person-running"]')?.getAttribute('aria-label')).toBe('action');
      expect(corner.querySelector('.lucide-user-round')).toBeNull();
    });

    it('shows identity and status only: no type control, Arm system label or environments', () => {
      const step = { id: 'hs_1', kind: 'rollout', title: 'Run the migration', state: 'pending', who: 'admin', due: 'after_merge', blocks: ['sign_off'] } as const;
      const { getByTestId, queryByTestId } = renderBar(view({ status: 'in_progress', type: 'same', humanSteps: [step], group: 'g' }));
      const list = getByTestId('glob-list');
      expect(list.className).toContain('text-muted-foreground');
      expect(list.className).not.toContain('font-medium');
      const bar = getByTestId('glob-header');
      expect(queryByTestId('glob-type')).toBeNull();
      expect(queryByTestId('arm-system-label')).toBeNull();
      expect(queryByTestId('environment-chip')).toBeNull();
      expect(bar.textContent).not.toMatch(/same|Arm system/);
    });

    it('agrees with the card on the human outline: your turn, awaiting sign-off, escalated Planning', () => {
      const humans: readonly GlobView[] = [
        prOpen({ allowedActions: ['merge'] }),
        view({ status: 'reviewing', labels: { CR: 'required' } }),
        view({ status: 'planning', escalation: { reason: 'touches billing', at: NOW } as GlobView['escalation'] }),
      ];
      for (const g of humans) {
        const { getByTestId } = renderBar(g);
        const header = getByTestId('header-status');
        expect(header.lastElementChild?.tagName.toLowerCase()).toBe('svg');
        const text = header.textContent;
        cleanup();
        const { container } = render(
          <MemoryRouter>
            <GlobCard glob={g} onOpen={() => undefined} onOpenSection={() => undefined} onReviewLabel={() => Promise.resolve(true)} moves={[]} previewing={null} onPreview={() => undefined} onMove={() => undefined} onArrow={() => undefined} />
          </MemoryRouter>,
        );
        const status = container.querySelector('[data-testid="card-status"]');
        expect(['human', 'needs-human']).toContain(status?.getAttribute('data-icon'));
        expect(status?.querySelector('.truncate')?.textContent).toBe(text);
        cleanup();
      }
    });

    // Slop merges these once the checks pass; the board's base here is `develop`, and `behind` is cleared after a base merge.
    const moved = { sha: 'aaaaaaa1111', state: 'pending' as const };
    const merging: readonly [string, () => GlobView, string][] = [
      ['status merging, checks pending', () => view({ status: 'merging', pr: { number: 7, state: 'ready', headSha: head }, headChecks: { sha: head, state: 'pending' } }), 'running checks'],
      ['an armed merge', () => prOpen({ headChecks: { sha: head, state: 'pending' }, mergeMode: 'when_green', allowedActions: ['cancel_merge'] }), 'running checks'],
      ['status merging, head moved after a base merge', () => view({ status: 'merging', pr: { number: 7, state: 'ready', headSha: head }, headChecks: moved, behind: null }), 'merging from develop'],
      ['an armed merge, head moved after a base merge', () => prOpen({ headChecks: moved, behind: null, mergeMode: 'when_green', allowedActions: ['cancel_merge'] }), 'merging from develop'],
    ];
    it.each(merging)('%s: the card and the header both read the merging words', (_name, make, text) => {
      const g = make();
      const { getByTestId } = renderBar(g, undefined, undefined, 'develop');
      const header = getByTestId('header-status').textContent;
      cleanup();
      const { container } = render(
        <MemoryRouter>
          <GlobCard
            glob={g}
            onOpen={() => undefined}
            onOpenSection={() => undefined}
            onReviewLabel={() => Promise.resolve(true)}
            moves={[]}
            previewing={null}
            onPreview={() => undefined}
            onMove={() => undefined}
            onArrow={() => undefined}
            base='develop'
          />
        </MemoryRouter>,
      );
      expect(container.querySelector('[data-testid="card-status"] .truncate')?.textContent).toBe(text);
      expect(header).toBe(text);
    });

    it.each(cases)('%s: the card status and the header status say the same words', (_name, make) => {
      const g = make();
      const { getByTestId } = renderBar(g);
      const header = getByTestId('header-status').textContent;
      cleanup();
      const { container } = render(
        <MemoryRouter>
          <GlobCard
            glob={g}
            onOpen={() => undefined}
            onOpenSection={() => undefined}
            onReviewLabel={() => Promise.resolve(true)}
            moves={[]}
            previewing={null}
            onPreview={() => undefined}
            onMove={() => undefined}
            onArrow={() => undefined}
          />
        </MemoryRouter>,
      );
      const card = container.querySelector('[data-testid="card-status"] .truncate')?.textContent;
      expect(card).toBeTruthy();
      expect(header).toBe(card);
    });

    it("says the same words for a signed-in viewer's own rollout step", () => {
      const admin = { email: 'admin@example.com', role: 'admin' } as const;
      const step = (id: string, state: 'done' | 'due') => ({ id, kind: 'rollout', title: 'Roll out', state, who: 'admin', due: 'after_merge', blocks: ['sign_off'], detail: null, script: null, check: null, source: 'work', doneBy: null, doneAt: null });
      const g = view({ status: 'reviewing', updatedAt: fresh, move: { holder: 'you', reason: 'Roll out', since: null }, pr: { number: 7, state: 'merged', headSha: 'abc' }, humanSteps: [step('a', 'done'), step('b', 'due')] } as Partial<GlobView>);
      const { getByTestId } = renderBar(g, undefined, admin);
      const header = getByTestId('header-status').textContent;
      cleanup();
      const { container } = render(
        <MemoryRouter>
          <GlobCard glob={g} viewer={admin} onOpen={() => undefined} onOpenSection={() => undefined} onReviewLabel={() => Promise.resolve(true)} moves={[]} previewing={null} onPreview={() => undefined} onMove={() => undefined} onArrow={() => undefined} />
        </MemoryRouter>,
      );
      expect(container.querySelector('[data-testid="card-status"] .truncate')?.textContent).toBe('rollout');
      expect(header).toBe('rollout');
    });

    it('shows "ID · list" on the left and, with nothing happening, only the kind marker on the right', () => {
      const { getByTestId, queryByTestId } = renderBar(view({ status: 'planning', list: 'planning', category: 'bug' }));
      const left = getByTestId('glob-header');
      expect(getByTestId('glob-list').textContent).toBe('Planning');
      expect(queryByTestId('header-status')).toBeNull();
      const corner = getByTestId('header-corner');
      expect(corner.querySelector('[data-testid="header-dot"]')).toBeNull();
      expect(corner.children).toHaveLength(1);
      expect(corner.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('bug');
      expect(left.textContent).not.toContain('Planning ');
    });

    it('shows the card\'s corner, a dot, then the kind marker for a merging bug, and never the list name', () => {
      const g = view({ status: 'merging', list: 'doing', category: 'bug', pr: { number: 7, state: 'ready', headSha: 'abc' }, headChecks: { sha: 'abc', state: 'passed' } });
      const { getByTestId } = renderBar(g);
      const corner = getByTestId('header-corner');
      expect(getByTestId('header-status').textContent).toBe('merging');
      expect([...corner.children].map((c) => c.getAttribute('data-testid') ?? 'marker')).toEqual(['header-status', 'header-dot', 'marker']);
      expect(corner.children[2]?.className).toContain('ml-1.5');
      expect(getByTestId('header-status').textContent).not.toContain('Doing');
      expect(getByTestId('glob-list').textContent).toContain('Doing');
    });
  });
});
