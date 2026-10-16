// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploysSection } from '../src/components/deploys';
import type { GlobView } from '../src/lib/api';
import { NOW, glob } from '../../../packages/core/test/fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const deploy = (id: string) => ({
  id,
  environment: 'dev',
  sha: 'abc1234def',
  state: 'succeeded',
  trigger: 'push',
  requestedBy: null,
  requestedAt: NOW,
  startedAt: null,
  finishedAt: NOW,
  url: null,
  error: null,
});

const show = (deploys: unknown[]) => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ value: deploys }), { status: 200 }))));
  const g = { ...glob(), boardId: 1 } as GlobView;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DeploysSection glob={g} />
    </QueryClientProvider>,
  );
};

describe('DeploysSection', () => {
  it('shows nothing, and no Deploy now button, when the glob has no deploys', async () => {
    const { queryByTestId, container } = show([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(queryByTestId('deploys')).toBeNull();
    expect(container.textContent).not.toMatch(/Deploy now|No deploys yet/);
  });

  it('lists the deploys collapsed by default, with no Deploy now button', async () => {
    const { findByTestId, getAllByTestId, container } = show([deploy('d1'), deploy('d2')]);
    await findByTestId('deploys');
    await waitFor(() => expect(getAllByTestId('deploy-row')).toHaveLength(2));
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('button')).toBeNull();
  });
});
