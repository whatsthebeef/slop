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
  const renderBar = (g: GlobView, setup?: () => void, viewer?: { email: string; role: 'admin' }) => {
    setup?.();
    const ctx = { glob: g, onUpdate: () => Promise.resolve(null) } as unknown as GlobViewContext;
    const Bar = () => {
      const state = useNowState(g, false, [], { viewer } as unknown as GlobActionsState);
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

  it('holds only the back arrow, the ID and the status: no title, branch or version', () => {
    const { getByTestId } = renderBar(view({ title: 'A very long title that would wrap', version: 7 }));
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
    expect(getByTestId('glob-back').className).toContain('p-1.5');
  });

  it('scrolls to the Activity log when the status is clicked', () => {
    const { getByTestId } = renderBar(view());
    const target = document.createElement('div');
    target.id = ACTIVITY_ID;
    const scrollIntoView = vi.fn();
    Object.defineProperty(target, 'scrollIntoView', { value: scrollIntoView });
    document.body.append(target);
    getByTestId('header-status').click();
    expect(scrollIntoView).toHaveBeenCalled();
    target.remove();
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
      ['prerequisites', () => view({ status: 'planning', blockedBy: [{ id: 's1t1', state: 'open', status: 'implementing', depth: 1 }], nextStartable: 's1t9' })],
      ['checks running', () => prOpen({ headChecks: { sha: head, state: 'pending' }, ...live('watching') })],
      ['a problem', () => prOpen({ conflict: { base: 'main', files, since: 's1t9', at: NOW } })],
    ];
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
      expect(container.querySelector('[data-testid="card-status"] .truncate')?.textContent).toBe('Merged; rollout 1/2 (Your turn)');
      expect(header).toBe('Merged; rollout 1/2 (Your turn)');
    });

    it('keeps the lifecycle text only where the shared status has nothing to say', () => {
      const { getByTestId } = renderBar(view({ status: 'planning' }));
      expect(getByTestId('header-status').textContent).toBe('Planning');
    });
  });
});
