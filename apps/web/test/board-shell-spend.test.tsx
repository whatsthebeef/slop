// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardTabs } from '../src/components/board-shell';

vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api: {
    inbox: vi.fn().mockResolvedValue([]),
    spend: vi.fn().mockResolvedValue({ usd: 1.5, unpricedCalls: 0, bySource: { chat: 1.5 } }),
  },
}));

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('board header spend line', () => {
  it('shows the spend with its tooltip and hides it below sm', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BoardTabs boardId={1} onActions={vi.fn()} onChat={vi.fn()} chatOpen={false} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const span = await screen.findByTestId('llm-spend');
    expect(span.textContent).toBe('LLM spend this month $1.50');
    expect(span.title).toBe('chat $1.50');
    expect(span.className).toContain('hidden');
    expect(span.className).toContain('sm:inline');
  });
});
