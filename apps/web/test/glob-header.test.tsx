// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobHeader, HEADER_HEIGHT_VAR } from '../src/components/glob-view/header';
import type { GlobViewContext } from '../src/components/glob-view/context';
import type { GlobActionsState } from '../src/components/glob-view/actions';
import { ACTIVITY_ID, useNowState } from '../src/components/glob-view/status';
import type { GlobView } from '../src/lib/api';
import { glob } from '../../../packages/core/test/fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GlobHeader', () => {
  const renderBar = (g: GlobView, setup?: () => void) => {
    setup?.();
    const ctx = { glob: g, onUpdate: () => Promise.resolve(null) } as unknown as GlobViewContext;
    const Bar = () => {
      const state = useNowState(g, false, [], {} as GlobActionsState);
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
});
