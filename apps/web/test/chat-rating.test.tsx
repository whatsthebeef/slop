// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rating } from '../src/components/chat-panel';
import { ChatTestCases } from '../src/components/chat-test-cases';

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the 👎 test cases list', () => {
  it('shows each bad answer with its question and note', async () => {
    const c = { id: 1, boardId: 1, question: 'Why X?', answer: 'Because.', citations: [], tools: ['Searched'], page: null, note: 'Missed the plan', email: 'a@b.c', createdAt: '2026-10-14T10:00:00.000Z' };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ cases: [c] }), { status: 200, headers: { 'content-type': 'application/json' } }))));
    render(wrap(<ChatTestCases boardId={1} />));
    expect(await screen.findByText('Why X?')).toBeTruthy();
    expect(screen.getByText('Wrong: Missed the plan')).toBeTruthy();
  });

  it('says so when there are none', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ cases: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))));
    render(wrap(<ChatTestCases boardId={1} />));
    await waitFor(() => expect(screen.getByText('None yet.')).toBeTruthy());
  });
});

const bodyOf = (call: unknown[] | undefined): Record<string, unknown> => JSON.parse((call?.[1] as { body: string }).body) as Record<string, unknown>;
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const saved = (rating: 'up' | 'down', note: string | null) => ({ id: 1, messageId: 7, rating, note });
const message = { id: 7, role: 'assistant', content: 'A' } as never;

describe('rating an answer', () => {
  it('sends a 👎 with the page, then asks what was wrong and sends the note', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => json({ feedback: saved('down', (init as { body: string }).body.includes('Missed') ? 'Missed the plan' : null) }));
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<Rating boardId={1} chatId={2} message={message} page={{ type: 'glob', id: 's1t1' }} given={undefined} />));
    fireEvent.click(screen.getByLabelText('Bad answer'));
    const box = await screen.findByLabelText('What was wrong');
    const first = bodyOf(fetchMock.mock.calls[0]);
    expect(first).toEqual({ rating: 'down', page: { type: 'glob', id: 's1t1' } });
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/boards/1/chats/2/messages/7/feedback');
    fireEvent.change(box, { target: { value: 'Missed the plan' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetchMock.mock.calls[1])).toMatchObject({ rating: 'down', note: 'Missed the plan' });
  });

  it('sends a 👍 without asking for a note and shows the given verdict pressed', async () => {
    const fetchMock = vi.fn(() => json({ feedback: saved('up', null) }));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(wrap(<Rating boardId={1} chatId={2} message={message} page={{ type: 'board' }} given={undefined} />));
    fireEvent.click(screen.getByLabelText('Good answer'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText('What was wrong')).toBeNull();
    rerender(wrap(<Rating boardId={1} chatId={2} message={message} page={{ type: 'board' }} given={saved('up', null) as never} />));
    expect(screen.getByLabelText('Good answer').getAttribute('aria-pressed')).toBe('true');
  });
});
