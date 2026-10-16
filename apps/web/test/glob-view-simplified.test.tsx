// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobDecisions } from '../src/components/glob-decisions';
import { ReviewFindings } from '../src/components/review-findings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reply = (body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))),
  );

const wrap = (ui: React.ReactElement) => (
  <MemoryRouter>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
  </MemoryRouter>
);

const relation = { id: 2, globId: 's1t2', statement: 'New', decidedAt: '2026-10-02T00:00:00Z', state: 'applied', sourceLabel: 's', sourceUrl: null, oldQuote: null, newQuote: null, reason: null };
const decision = (patch: object) => ({
  id: 1,
  globId: 's1t1',
  statement: 'Use X',
  quote: 'q',
  decidedBy: 'ann',
  decidedAt: '2026-10-01T00:00:00Z',
  sourceKind: 'plan',
  sourceLabel: 'plan.md',
  sourceUrl: null,
  status: 'current',
  replacedBy: null,
  replaces: [],
  ...patch,
});

describe('Choices', () => {
  it('shows no Undo button on a current or a replaced choice, and keeps its text, who and when', async () => {
    window.localStorage.setItem('slop.choices-open', 'true');
    reply({ decisions: [decision({}), decision({ id: 3, status: 'superseded', replacedBy: relation })] });
    render(wrap(<GlobDecisions boardId={1} globId='s1t1' />));
    expect((await screen.findAllByTestId('decision')).length).toBe(2);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.getAllByText('ann').length).toBe(2);
    expect(screen.getAllByText('2026-10-01').length).toBe(2);
  });
});

describe('Review findings', () => {
  it('renders no category-count chips and still lists each finding', async () => {
    reply({
      findings: [
        { id: 1, severity: 'in_scope', class: 'correctness', path: null, line: null, round: 1, source: 'local_review', commitSha: null, state: 'classified', error: null, text: 'Off by one', classNote: null },
      ],
      byClass: [{ class: 'correctness', total: 1, inScope: 1, suggestions: 0 }],
      pending: 0,
      failed: 0,
      sources: { pending: 0, failed: 0 },
      waiting: null,
    });
    render(wrap(<ReviewFindings globId='s1t1' startOpen />));
    expect((await screen.findAllByTestId('finding')).length).toBe(1);
    expect(screen.queryByTestId('finding-class')).toBeNull();
  });
});
