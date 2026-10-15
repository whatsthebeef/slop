// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { Action } from '@slop/core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobDetail } from '../src/components/glob-dialog';
import type { BoardView, GlobView } from '../src/lib/api';
import { board as coreBoard, glob as coreGlob } from '../../../packages/core/test/fixtures';

const board: BoardView = { ...coreBoard, role: 'dev' };
const NOW = '2026-10-14T00:00:00Z';

const view = (patch: Partial<GlobView> = {}): GlobView => ({
  ...coreGlob(),
  list: 'planning',
  branch: 's1t1',
  currentRun: null,
  ...patch,
});

const renderGlob = (glob: GlobView) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobDetail
          board={board}
          glob={glob}
          initialArtifact={null}
          onClose={vi.fn()}
          onUpdate={vi.fn(() => Promise.resolve(null))}
          onReload={vi.fn(() => Promise.resolve())}
          onAction={vi.fn<(action: Action, anyway?: boolean) => Promise<boolean>>(() =>
            Promise.resolve(true),
          )}
          onReviewLabel={vi.fn()}
          onDismissEdge={vi.fn(() => Promise.resolve(true))}
          onAddRelation={vi.fn(() => Promise.resolve(true))}
          onDismiss={vi.fn(() => Promise.resolve(true))}
          onDecide={vi.fn(() => Promise.resolve(true))}
          onAddStep={vi.fn(() => Promise.resolve(true))}
          onCompleteStep={vi.fn(() => Promise.resolve(true))}
          onDismissStep={vi.fn(() => Promise.resolve(true))}
          onDelete={vi.fn(() => Promise.resolve())}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
});

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('no server in component tests'))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const escalated = (evidence?: string) =>
  view({
    escalation: {
      at: NOW,
      by: 'dev@example.com',
      reason: 'Touches auth',
      ...(evidence === undefined ? {} : { evidence }),
      criterion: 'risk_area',
    },
  });

const sizeCheck = (): NonNullable<GlobView['sizeCheck']> => ({
  globId: 's1t1',
  boardId: 1,
  planHash: 'h',
  estimate: {
    tasks: 6,
    doneWhenLines: 6,
    areas: ['web'],
    untaskedSections: 0,
    independentParts: 3,
    partsSource: 'model',
    parallelParts: 2,
    reasoning: null,
  },
  evidence: ['6 tasks'],
  threshold: { maxParts: 3, maxTasks: 5, minParallel: 2 },
  flagged: true,
  reasons: ['6 tasks'],
  proposal: {
    workstreams: [{ name: 'One', goal: 'goal', files: ['apps/one.ts'], plan: 'plan', needs: [] }],
  },
  decision: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const oversized = () =>
  view({
    status: 'planning',
    provisioning: 'none',
    runs: [],
    pr: null,
    allowedActions: ['start', 'delete'],
    oversized: true,
    sizeCheck: sizeCheck(),
  });

describe('information blocks', () => {
  it('shows the escalation as an info block: head, the reason as the why line, the evidence and author in the folded body', () => {
    renderGlob(escalated('From the split of s1t0: files a.ts'));
    const block = screen.getByTestId('escalation-note');
    expect(block.getAttribute('data-block')).toBe('info');
    expect(within(block).getByTestId('block-head').textContent).toBe('Why a person?');
    expect(within(block).getByTestId('block-why').textContent).toBe('Touches auth');
    const body = within(block).getByTestId('block-body');
    expect(body.tagName).toBe('DETAILS');
    expect(body.textContent).toContain('From the split of s1t0: files a.ts');
    expect(body.textContent).toContain('Escalated by dev@example.com');
    expect(within(block).queryAllByRole('button')).toHaveLength(0);
  });

  it('shows the escalation without evidence and never as Markdown', () => {
    renderGlob(escalated());
    const block = screen.getByTestId('escalation-note');
    expect(within(block).getByTestId('block-body').textContent).toBe(
      'DetailsEscalated by dev@example.com',
    );
    expect(block.querySelector('strong, em, a, ul, h1, h2')).toBeNull();
  });

  it('folds the escalation details by default', () => {
    renderGlob(escalated('evidence'));
    expect(
      within(screen.getByTestId('escalation-note')).getByTestId('block-body').hasAttribute('open'),
    ).toBe(false);
  });

  it('shows the size advice as an info block: the title, why line and the proposed workstreams, with no buttons', () => {
    renderGlob(oversized());
    const block = screen.getByTestId('oversized-proposal');
    expect(block.getAttribute('data-block')).toBe('info');
    expect(within(block).getByTestId('block-head').textContent).toBe(
      "Oversized: this looks like more than one PR's worth of work",
    );
    expect(within(block).getByTestId('block-why').textContent).toContain(
      'This is advice: s1t1 can start as it is, and the run works the workstreams in parallel.',
    );
    expect(within(block).getByTestId('oversized-parts').textContent).toContain('apps/one.ts');
    expect(within(block).queryAllByRole('button')).toHaveLength(0);
  });

  it('shows the size block while its advice loads, with the head and no why line', () => {
    renderGlob({ ...oversized(), sizeCheck: undefined });
    const block = screen.getByTestId('oversized-proposal');
    expect(within(block).getByTestId('block-head')).toBeTruthy();
    expect(within(block).queryByTestId('block-why')).toBeNull();
    expect(block.textContent).toContain('Loading the proposed workstreams');
  });
});
