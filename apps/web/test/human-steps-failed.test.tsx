// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HumanSteps } from '../src/components/human-steps';
import type { GlobView, ListedHumanStep } from '../src/lib/api';
import { glob as coreGlob } from '../../../packages/core/test/fixtures';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const step = (over: Partial<ListedHumanStep> & Pick<ListedHumanStep, 'id' | 'state'>): ListedHumanStep => ({
  kind: 'rollout',
  title: `Step ${over.id}`,
  who: 'admin',
  due: 'after_merge',
  blocks: ['sign_off'],
  ...over,
});

const show = (humanSteps: ListedHumanStep[], onFail?: (stepId: string, note: string) => Promise<boolean>, status: GlobView['status'] = 'reviewing') => {
  const glob = { ...coreGlob(), status, list: 'doing', branch: 's1t1', currentRun: null, humanSteps } as GlobView;
  render(
    <MemoryRouter>
      <HumanSteps
        glob={glob}
        canAdd
        onAdd={vi.fn(() => Promise.resolve(true))}
        onComplete={vi.fn(() => Promise.resolve(true))}
        onDismiss={vi.fn(() => Promise.resolve(true))}
        {...(onFail === undefined ? {} : { onFail })}
      />
    </MemoryRouter>,
  );
};

describe('failed step', () => {
  it('shows a note box, the credential warning and, for a merged rollout step, that a new run starts; reports the note once', async () => {
    const onFail = vi.fn<(stepId: string, note: string) => Promise<boolean>>(() => Promise.resolve(true));
    show([step({ id: 'a', state: 'due' })], onFail);
    await userEvent.click(screen.getByTestId('due-failed'));
    expect(screen.getByTestId('fail-warning').textContent).toBe(
      'Paste only what is needed; remove keys, tokens and passwords. Slop masks common ones, not all.',
    );
    expect(screen.getByTestId('fail-consequence').textContent).toBe('This starts a new run on a fresh branch from master.');
    expect(screen.getByTestId<HTMLButtonElement>('fail-confirm').disabled).toBe(true);
    await userEvent.type(screen.getByTestId('fail-note'), '  AccessDenied on iam:PassRole  ');
    await userEvent.click(screen.getByTestId('fail-confirm'));
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith('a', 'AccessDenied on iam:PassRole');
    // The form closes once the request went through.
    await vi.waitFor(() => expect(screen.queryByTestId('fail-form')).toBeNull());
  });

  it('ignores a second submit while the first is in flight, and keeps the note when the request fails', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const onFail = vi.fn<(stepId: string, note: string) => Promise<boolean>>(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    show([step({ id: 'a', state: 'due' })], onFail);
    await userEvent.click(screen.getByTestId('due-failed'));
    await userEvent.type(screen.getByTestId('fail-note'), 'boom');
    const form = screen.getByTestId<HTMLFormElement>('fail-form');
    form.requestSubmit();
    form.requestSubmit();
    expect(onFail).toHaveBeenCalledTimes(1);
    finish(false);
    await vi.waitFor(() => expect(screen.getByTestId<HTMLButtonElement>('fail-confirm').disabled).toBe(false));
    expect(screen.getByTestId<HTMLTextAreaElement>('fail-note').value).toBe('boom');
  });

  it('says the step stays open and asks for a fix glob for any other step, or a rollout step of an unmerged glob', async () => {
    show([step({ id: 'a', state: 'due', kind: 'done' })], vi.fn(() => Promise.resolve(true)));
    await userEvent.click(screen.getByTestId('due-failed'));
    expect(screen.getByTestId('fail-consequence').textContent).toBe('The step stays open and slop asks on the card whether a glob fixes it.');
    cleanup();
    show([step({ id: 'b', state: 'due' })], vi.fn(() => Promise.resolve(true)), 'in_progress');
    await userEvent.click(screen.getByTestId('due-failed'));
    expect(screen.getByTestId('fail-consequence').textContent).toBe('The step stays open and slop asks on the card whether a glob fixes it.');
  });

  it('offers It failed only when the page can send it', () => {
    show([step({ id: 'a', state: 'due' })], vi.fn(() => Promise.resolve(true)));
    expect(screen.getByTestId('due-failed').textContent).toBe('It failed');
    cleanup();
    show([step({ id: 'b', state: 'due' })]);
    expect(screen.queryByTestId('due-failed')).toBeNull();
  });
});
