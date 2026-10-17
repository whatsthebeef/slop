// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploysSection } from '../src/components/deploys';
import type { DeployView, GlobView } from '../src/lib/api';
import { NOW, glob } from '../../../packages/core/test/fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const deploy = (id: string, patch: Partial<DeployView> = {}): Partial<DeployView> => ({
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
  ...patch,
});

const show = (deploys: unknown[]) => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ value: deploys }), { status: 200 }))));
  const g = { ...glob(), boardId: 1 } as GlobView;
  return render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <DeploysSection glob={g} />
      </QueryClientProvider>
    </MemoryRouter>,
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

  it("links each finished build's log attachment in the glob view, beside CodeBuild's log", async () => {
    const logUrl = 'https://console.aws.example/build/1';
    const { findAllByTestId, getAllByText } = show([
      deploy('d1', { state: 'failed', error: 'CodeBuild failed in BUILD', logUrl }),
      deploy('d2', { logUrl }),
      // Still running, or finished with no log link (no attachment): nothing to link.
      deploy('d3', { state: 'running', finishedAt: null, logUrl }),
      deploy('d4', { logUrl: null }),
    ]);
    const links = await findAllByTestId('deploy-build-log');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `/boards/1/globs/${glob().id}?section=artifacts&artifact=attachment&label=Build+log+%28dev%2C+failed%2C+abc1234%29`,
      `/boards/1/globs/${glob().id}?section=artifacts&artifact=attachment&label=Build+log+%28dev%2C+abc1234%29`,
    ]);
    expect(getAllByText('log').map((a) => a.getAttribute('href'))).toEqual([logUrl, logUrl, logUrl]);
  });
});
