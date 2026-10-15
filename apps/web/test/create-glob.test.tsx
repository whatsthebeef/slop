// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateGlobDialog, withActor, withMode } from '../src/components/create-glob';
import { api } from '../src/lib/api';
import type { BoardView, IntakeProposalView, NewGlob } from '../src/lib/api';
import { board as coreBoard } from '../../../packages/core/test/fixtures';

const board: BoardView = { ...coreBoard, role: 'dev' };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

describe('CreateGlobDialog who and how', () => {
  const created = () => vi.fn<(input: NewGlob) => Promise<{ id: string }>>(() => Promise.resolve({ id: 's1t1' }));

  it('offers no category: a machine same by default, and the actor\'s modes only', async () => {
    const onCreate = created();
    renderDialog(onCreate);
    expect(screen.queryByLabelText('Category')).toBeNull();
    expect(screen.getByLabelText<HTMLSelectElement>('Who').value).toBe('machine');
    expect([...screen.getByLabelText<HTMLSelectElement>('How').options].map((o) => o.value)).toEqual(['sub', 'same', 'super']);
    await userEvent.type(screen.getByLabelText('Title'), 'Do it');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const sent = onCreate.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ actor: 'machine', mode: 'same' });
    expect(sent).not.toHaveProperty('category');
    expect(sent).not.toHaveProperty('type');
    // Nothing was inferred without Process, so the server decides.
    expect(sent).not.toHaveProperty('fix');
  });

  it('a human gets only the action mode and an assignee, no environment', async () => {
    const onCreate = created();
    renderDialog(onCreate);
    await userEvent.selectOptions(screen.getByLabelText('Who'), 'human');
    expect([...screen.getByLabelText<HTMLSelectElement>('How').options].map((o) => o.value)).toEqual(['action']);
    expect(screen.getByTestId('assignee')).toBeTruthy();
    expect(screen.queryByLabelText('Environment')).toBeNull();
    await userEvent.type(screen.getByLabelText('Title'), 'Rotate it');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ actor: 'human', mode: 'action' });
  });

  it('Process fills the fix and work kind chips, a flip is the person\'s, and both are sent back', async () => {
    const proposal = {
      title: 'Fix the export',
      plan: 'The export fails.',
      type: 'same',
      category: 'bug',
      fix: true,
      fixSource: 'inferred',
      fixReason: 'The request says fails',
      workKind: 'maintenance',
      workKindSource: 'inferred',
      workKindReason: 'A fix is maintenance',
      group: null,
      environment: null,
      autoTrigger: false,
      autoTriggerReason: null,
      suggestedAfter: [],
      categoryConfidence: 'high',
      categoryReason: null,
      examples: [],
      needsConfirmation: false,
      model: 'm',
      promptVersion: 8,
    } as unknown as IntakeProposalView;
    vi.spyOn(api, 'intake').mockResolvedValue(proposal);
    const onCreate = created();
    renderDialog(onCreate);
    await userEvent.type(screen.getByLabelText(/Describe the work/), 'The export fails');
    await userEvent.click(screen.getByRole('button', { name: 'Process' }));
    const fix = await screen.findByTestId('chip-fix');
    expect(fix.textContent).toBe('Fix');
    // The work kind is inferred silently: there is no chip to choose it.
    expect(screen.queryByTestId('chip-work-kind')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      actor: 'machine',
      mode: 'same',
      fix: true,
      fixSource: 'inferred',
      workKind: 'maintenance',
      workKindSource: 'inferred',
      inferenceReason: 'The request says fails A fix is maintenance',
    });
  });

  it('keeps the form valid: a fix is never a super, and switching to human drops the machine fields', () => {
    const base: NewGlob = { title: 't', actor: 'machine', mode: 'same', fix: true, fixSource: 'inferred', workKind: 'rnd', workKindSource: 'inferred', group: null, environment: 'staging', autoTrigger: true };
    expect(withMode(base, 'super')).toMatchObject({ mode: 'super', fix: false, fixSource: 'person' });
    expect(withMode(base, 'sub')).toMatchObject({ mode: 'sub', fix: true });
    const human = withActor(base, 'human');
    expect(human).toMatchObject({ actor: 'human', mode: 'action', environment: null, autoTrigger: false });
    expect(human).not.toHaveProperty('fix');
    expect(human).not.toHaveProperty('workKind');
    expect(withActor(human, 'machine')).toMatchObject({ actor: 'machine', mode: 'same' });
  });
});
