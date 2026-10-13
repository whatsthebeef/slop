// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobHeader, HEADER_HEIGHT_VAR } from '../src/components/glob-view/header';
import type { GlobViewContext } from '../src/components/glob-view/context';
import type { GlobView } from '../src/lib/api';
import { glob } from '../../../packages/core/test/fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GlobHeader scroll margin', () => {
  it("publishes the bar's measured height on the page and follows it when the title wraps", () => {
    let notify: () => void = () => undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    let height = 40;
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    const ctx = { glob: { ...glob(), boardId: 1 } as GlobView, onUpdate: () => Promise.resolve(null) } as unknown as GlobViewContext;
    const { getByTestId } = render(
      <MemoryRouter>
        <article>
          <GlobHeader ctx={ctx} onClose={() => undefined} onReload={() => Promise.resolve()} />
        </article>
      </MemoryRouter>,
    );
    const page = getByTestId('glob-header').parentElement as HTMLElement;
    expect(page.style.getPropertyValue(HEADER_HEIGHT_VAR)).toBe('40px');
    height = 96;
    notify();
    expect(page.style.getPropertyValue(HEADER_HEIGHT_VAR)).toBe('96px');
  });
});
