// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestsSection } from '../src/components/deploys';
import { atfLine } from '../src/components/glob-card';
import type { AtfRun, GlobView } from '../src/lib/api';
import { glob } from '../../../packages/core/test/fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);

const run = (patch: Partial<AtfRun> = {}): AtfRun => ({
  id: 1,
  scope: 'environment',
  environment: 'staging',
  sha: 'abcdef1234567',
  passed: 40,
  failed: 0,
  skipped: 0,
  url: 'https://ci.example/run/1',
  at: '2026-10-05T12:00:00.000Z',
  failing: false,
  ...patch,
});

describe('the ATF run line', () => {
  it('adds the planned spec counts to the run line', () => {
    expect(
      atfLine(
        run({
          plannedSpecs: { total: 3, passed: 1, failed: 1, skipped: 0, missing: 0, unreported: 1 },
        }),
      ),
    ).toContain("this glob's planned specs: 1 passed, 1 failed, 1 not reported");
    expect(atfLine(run())).not.toContain('planned specs');
  });
});

describe('the Tests section', () => {
  const reply = (body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
  const view = glob({ id: 's1t1' }) as GlobView;

  it('lists each planned spec with its result and run link, "no result yet" for the unreported', async () => {
    reply({
      value: [run()],
      specs: [
        {
          spec: 'e2e/a.spec.ts',
          status: 'passed',
          runId: 1,
          url: 'https://ci.example/run/1',
          at: '2026-10-05T12:00:00.000Z',
        },
        {
          spec: 'e2e/b.spec.ts',
          status: 'failed',
          runId: 1,
          url: null,
          at: '2026-10-05T12:00:00.000Z',
        },
        {
          spec: 'e2e/c.spec.ts',
          status: 'missing',
          runId: 1,
          url: null,
          at: '2026-10-05T12:00:00.000Z',
        },
        { spec: 'e2e/d.spec.ts', status: null },
      ],
    });
    render(wrap(<TestsSection glob={view} />));
    const rows = await screen.findAllByTestId('spec-result');
    expect(
      rows.map((r) => [r.getAttribute('data-status'), r.textContent.includes('no result yet')]),
    ).toEqual([
      ['passed', false],
      ['failed', false],
      ['missing', false],
      ['none', true],
    ]);
    const row = (i: number): HTMLElement => {
      const found = rows[i];
      if (found === undefined) throw new Error(`no row ${String(i)}`);
      return found;
    };
    expect(within(row(0)).getByRole('link', { name: 'run' }).getAttribute('href')).toBe(
      'https://ci.example/run/1',
    );
    expect(within(row(2)).getByText(/missing/)).toBeTruthy();
    expect(screen.getAllByTestId('test-run')).toHaveLength(1);
  });

  it('still shows runs from a server that sends no spec results, and nothing when there is neither', async () => {
    reply({ value: [run()] });
    render(wrap(<TestsSection glob={view} />));
    expect(await screen.findAllByTestId('test-run')).toHaveLength(1);
    expect(screen.queryByTestId('spec-results')).toBeNull();
    cleanup();
    reply({ value: [], specs: [] });
    const { container } = render(wrap(<TestsSection glob={view} />));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector('[data-testid="tests"]')).toBeNull();
  });

  it('shows planned specs before any run reports', async () => {
    reply({ value: [], specs: [{ spec: 'e2e/a.spec.ts', status: null }] });
    render(wrap(<TestsSection glob={view} />));
    expect((await screen.findByTestId('spec-result')).textContent).toContain('no result yet');
  });
});
