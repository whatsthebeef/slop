// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OpenQuestion } from '@slop/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionChip } from '../src/components/glob-card';
import type { GlobViewContext } from '../src/components/glob-view/context';
import { QuestionsSection } from '../src/components/glob-view/questions';
import type { GlobView } from '../src/lib/api';
import { board as coreBoard, glob as coreGlob, NOW } from '../../../packages/core/test/fixtures';

afterEach(cleanup);

const question = (patch: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id: 'q1',
  text: 'Is prod in scope?',
  raisedBy: { kind: 'intake', actor: null },
  source: 'create',
  blocking: 'start',
  raisedAt: NOW,
  ...patch,
});

const view = (questions: OpenQuestion[], patch: Partial<GlobView> = {}): GlobView => ({
  ...coreGlob(),
  list: 'planning',
  branch: 's1t1',
  currentRun: null,
  status: 'planning',
  questions,
  ...patch,
});

const setup = (glob: GlobView, busy = false) => {
  const ctx: GlobViewContext = {
    board: { ...coreBoard, role: 'dev' },
    glob,
    groups: [],
    busy,
    onAction: vi.fn(() => Promise.resolve(true)),
    onUpdate: vi.fn(() => Promise.resolve(null)),
    onOpenSection: vi.fn(),
  };
  const onAnswer = vi.fn(() => Promise.resolve(true));
  const onDismiss = vi.fn(() => Promise.resolve(true));
  render(<QuestionsSection ctx={ctx} onAnswer={onAnswer} onDismiss={onDismiss} />);
  return { onAnswer, onDismiss };
};

const dismissButton = (index: number): HTMLElement => {
  const button = screen.getAllByRole('button', { name: 'Dismiss' })[index];
  if (button === undefined) throw new Error(`no Dismiss button ${String(index)}`);
  return button;
};

describe('QuestionsSection', () => {
  it('renders nothing for a glob without questions (older API)', () => {
    const { container } = render(
      <QuestionsSection
        ctx={{ board: { ...coreBoard, role: 'dev' }, glob: { ...view([]), questions: undefined }, groups: [], busy: false, onAction: vi.fn(), onUpdate: vi.fn(), onOpenSection: vi.fn() }}
        onAnswer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('answers with an option in one request', async () => {
    const { onAnswer } = setup(view([question({ options: ['Yes', 'No'] })]));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Yes' }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('q1', { answer: 'Yes', option: 'Yes' });
  });

  it('answers with free text', async () => {
    const { onAnswer } = setup(view([question()]));
    const user = userEvent.setup();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Answer' }).disabled).toBe(true);
    await user.type(screen.getByLabelText('Answer q1'), 'Yes, include prod');
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    expect(onAnswer).toHaveBeenCalledWith('q1', { answer: 'Yes, include prod' });
  });

  it('dismisses with and without a note', async () => {
    const { onDismiss } = setup(view([question(), question({ id: 'q2', text: 'Second?' })]));
    const user = userEvent.setup();
    await user.click(dismissButton(0));
    await user.type(screen.getByLabelText('Dismiss note q1'), 'fine as is');
    await user.click(screen.getByRole('button', { name: 'Go ahead as is' }));
    expect(onDismiss).toHaveBeenCalledWith('q1', 'fine as is');
    await user.click(dismissButton(1));
    await user.click(screen.getByRole('button', { name: 'Go ahead as is' }));
    expect(onDismiss).toHaveBeenLastCalledWith('q2', undefined);
  });

  it('folds answered and dismissed questions under the open ones', () => {
    setup(
      view([
        question({ id: 'q1', text: 'Open one?' }),
        question({ id: 'q2', text: 'Answered one?', answer: { text: 'Yes', by: 'a@x.io', at: NOW } }),
        question({ id: 'q3', text: 'Dismissed one?', dismissed: { by: 'b@x.io', at: NOW, note: 'ok' } }),
      ]),
    );
    expect(screen.getByTestId('question-q1')).toBeTruthy();
    expect(screen.queryByTestId('question-q2')).toBeNull();
    const closed = screen.getByTestId('questions-closed');
    expect(closed.querySelector('details')).not.toBeNull();
    expect(closed.textContent).toContain('Answered by a@x.io');
    expect(closed.textContent).toContain('Dismissed by b@x.io');
  });

  it('disables the controls while busy', () => {
    setup(view([question({ options: ['Yes'] })]), true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Yes' }).disabled).toBe(true);
  });
});

describe('QuestionChip', () => {
  it('shows the open count and describes itself with the first question', () => {
    const html = renderToStaticMarkup(
      <QuestionChip glob={view([question(), question({ id: 'q2', text: 'Other' })])} onOpen={() => undefined} />,
    );
    expect(html).toContain('Question 2');
    expect(html).toContain('Is prod in scope?');
    expect(html).toContain('aria-describedby');
  });

  it('is absent when nothing is open', () => {
    const answered = question({ answer: { text: 'Yes', by: 'a', at: NOW } });
    expect(renderToStaticMarkup(<QuestionChip glob={view([answered])} />)).toBe('');
    expect(renderToStaticMarkup(<QuestionChip glob={{ ...view([]), questions: undefined }} />)).toBe('');
  });
});
