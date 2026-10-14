// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateGlobDialog } from '../src/components/create-glob';
import type { BoardView, NewGlob } from '../src/lib/api';
import { board as coreBoard } from '../../../packages/core/test/fixtures';

const board: BoardView = { ...coreBoard, role: 'dev' };

afterEach(() => {
  cleanup();
});

const renderDialog = (onCreate: (input: NewGlob) => Promise<{ id: string } | undefined>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={client}>
      <CreateGlobDialog board={board} groups={['Billing']} initialGroup='Billing' open onOpenChange={vi.fn()} onCreate={onCreate} />
    </QueryClientProvider>
  );
  return render(ui);
};

describe('CreateGlobDialog initialGroup', () => {
  it('starts with the group and keeps it after a create resets the form', async () => {
    const onCreate = vi.fn<(input: NewGlob) => Promise<{ id: string }>>(() => Promise.resolve({ id: 's1t1' }));
    renderDialog(onCreate);
    const group = screen.getByLabelText<HTMLInputElement>('Group');
    expect(group.value).toBe('Billing');

    await userEvent.type(screen.getByLabelText('Title'), 'Fix it');
    await userEvent.clear(group);
    await userEvent.type(group, 'Other');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0].group).toBe('Other');
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe(''));
    expect(screen.getByLabelText<HTMLInputElement>('Group').value).toBe('Billing');
  });
});
