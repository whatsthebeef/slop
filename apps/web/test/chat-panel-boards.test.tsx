// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/components/chat-panel';
import { RequestError } from '../src/lib/api';

const { chatMessages } = vi.hoisted(() => ({ chatMessages: vi.fn() }));

vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api: {
    chatMessages,
    myChatFeedback: vi.fn().mockResolvedValue([]),
    chats: vi.fn().mockResolvedValue([]),
    globs: vi.fn().mockResolvedValue([]),
  },
}));

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => undefined;
});

afterEach(() => {
  cleanup();
  chatMessages.mockReset();
});

const panel = (boardId: number, chatId: number | null, onChatChange = vi.fn()) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <ChatPanel
        boardId={boardId}
        fullScreen={false}
        focusToken={0}
        chatId={chatId}
        onChatChange={onChatChange}
        onClose={vi.fn()}
        onFullScreenChange={vi.fn()}
      />
    </MemoryRouter>
  </QueryClientProvider>
);

describe('chat panel across boards', () => {
  it('drops a conversation the board no longer has and shows a new chat without an error', async () => {
    chatMessages.mockRejectedValue(new RequestError(404, { code: 'not_found', message: 'No conversation 25' }));
    const onChatChange = vi.fn();
    render(panel(2, 25, onChatChange));
    await waitFor(() => expect(onChatChange).toHaveBeenCalledWith(null));
    expect(screen.queryByText('No conversation 25')).toBeNull();
  });

  it('does not ask a board for another board\'s conversation', async () => {
    chatMessages.mockResolvedValue([]);
    const { rerender } = render(panel(1, 25));
    await waitFor(() => expect(chatMessages).toHaveBeenCalledWith(1, 25));
    rerender(panel(2, null));
    await screen.findByTestId('chat-suggestions');
    expect(chatMessages).not.toHaveBeenCalledWith(2, 25);
  });

  it('shows other failures to load a conversation', async () => {
    chatMessages.mockRejectedValue(new RequestError(500, { code: 'internal', message: 'boom' }));
    render(panel(1, 7));
    expect(await screen.findByText('boom')).toBeTruthy();
  });
});
