// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HumanSteps } from '../src/components/human-steps';
import { viewSections } from '../src/components/glob-view/sections';
import type { GlobView, ListedHumanStep } from '../src/lib/api';
import { hasDueSteps, quietText } from '../src/lib/human-steps';
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

const show = (humanSteps: ListedHumanStep[], handlers = { onComplete: vi.fn(() => Promise.resolve(true)), onDismiss: vi.fn(() => Promise.resolve(true)) }) => {
  const glob = { ...coreGlob(), list: 'doing', branch: 's1t1', currentRun: null, humanSteps } as GlobView;
  render(
    <MemoryRouter>
      <HumanSteps glob={glob} canAdd onAdd={vi.fn(() => Promise.resolve(true))} {...handlers} />
    </MemoryRouter>,
  );
  return handlers;
};

describe('due steps block', () => {
  it('renders each due step as a card with its text, who, script command, Done and Dismiss', async () => {
    const detail = 'Why: the host needs it\nDo this: run the script\nPermissions: admin\nCheck it worked: it prints ok';
    const h = show([step({ id: 'a', state: 'due', detail, script: { path: 'scripts/x.sh' } }), step({ id: 'b', state: 'due' })]);
    expect(screen.getByTestId('due-steps').textContent).toContain('2 steps need you');
    expect(screen.getAllByTestId('due-step')).toHaveLength(2);
    const first = screen.getAllByTestId('due-step')[0] as HTMLElement;
    expect(first.querySelector('[data-testid="step-detail"]')?.textContent).toBe(detail);
    expect(first.querySelector('[data-testid="step-script-path"]')?.textContent).toBe('bash scripts/x.sh');
    expect(first.querySelector('[data-testid="step-who"]')?.textContent).toBe('for the admin');
    await userEvent.click(first.querySelector('[data-testid="due-done"]') as HTMLElement);
    expect(h.onComplete).toHaveBeenCalledWith('a');
    await userEvent.click(first.querySelector('[data-testid="due-dismiss"]') as HTMLElement);
    await userEvent.type(screen.getByTestId('dismiss-reason'), 'wrong');
    await userEvent.click(screen.getByTestId('dismiss-confirm'));
    expect(h.onDismiss).toHaveBeenCalledWith('a', 'wrong');
  });

  it('lays a structured step out as Why, Before you start, Run (script command once, then each command in a copy box) and Check it worked', async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    show([
      step({
        id: 'a',
        state: 'due',
        why: 'The buildspec declares an atf report group',
        permissions: 'An AWS session in the prod account',
        script: { path: 'scripts/x.sh' },
        commands: ['aws sso login', 'aws codebuild list-report-groups'],
        verify: 'The list shows the atf group',
      }),
    ]);
    const card = screen.getByTestId('due-step');
    const text = card.textContent;
    expect(text).toContain('Why: The buildspec declares an atf report group');
    expect(text).toContain('Before you start: An AWS session in the prod account');
    expect(text).toContain('Check it worked: The list shows the atf group');
    expect(card.querySelectorAll('[data-testid="step-script-path"]')).toHaveLength(1);
    expect(text.split('scripts/x.sh')).toHaveLength(2);
    const commands = [...card.querySelectorAll('[data-testid="step-command"]')].map(
      (c) => c.textContent,
    );
    expect(commands).toEqual(['aws sso login', 'aws codebuild list-report-groups']);
    expect(card.querySelectorAll('button[data-testid="step-command-copy"]')).toHaveLength(2);
    expect(text).not.toContain('`');
    await userEvent.click(
      card.querySelectorAll('[data-testid="step-command-copy"]')[1] as HTMLElement,
    );
    expect(write).toHaveBeenCalledWith('aws codebuild list-report-groups');
  });

  it('leaves empty fields out, so an old free-text step still renders as its detail alone', () => {
    show([step({ id: 'a', state: 'due', detail: 'Just do it', commands: [] })]);
    const card = screen.getByTestId('due-step');
    expect(screen.getByTestId('step-detail').textContent).toBe('Just do it');
    for (const id of ['step-why', 'step-permissions', 'step-run', 'step-verify', 'step-command'])
      expect(card.querySelector(`[data-testid="${id}"]`)).toBeNull();
  });

  it('renders the step text as plain text, not Markdown', () => {
    show([step({ id: 'a', state: 'due', detail: '**Why** `code`' })]);
    expect(screen.getByTestId('step-detail').textContent).toBe('**Why** `code`');
  });

  it('collapses steps not yet due into one quiet line that expands', async () => {
    show([step({ id: 'a', state: 'pending' }), step({ id: 'b', state: 'pending' })]);
    expect(screen.queryByTestId('due-steps')).toBeNull();
    expect(screen.getByTestId('quiet-toggle').textContent).toBe('2 steps after merge ▸');
    expect(screen.queryAllByTestId('human-step')).toHaveLength(0);
    await userEvent.click(screen.getByTestId('quiet-toggle'));
    expect(screen.getAllByTestId('human-step')).toHaveLength(2);
  });

  it('shows no block and no quiet line when nothing is due or pending', () => {
    show([step({ id: 'a', state: 'done' })]);
    expect(screen.queryByTestId('due-steps')).toBeNull();
    expect(screen.queryByTestId('quiet-toggle')).toBeNull();
  });

  it('words the quiet line', () => {
    expect(quietText([step({ id: 'a', state: 'pending' })])).toBe('1 step after merge');
    expect(quietText([step({ id: 'a', state: 'pending', due: 'now' })])).toBe('1 step not due yet');
  });
});

describe('where the steps sit in the glob view', () => {
  it('moves Human steps to the top while a step is due, so a deep link lands on the block', () => {
    const order = viewSections(false, true);
    expect(order.indexOf('human-steps')).toBe(order.indexOf('escalation') + 1);
    expect(order.indexOf('human-steps')).toBeLessThan(order.indexOf('labels'));
    expect(new Set(order).size).toBe(order.length);
    expect(viewSections(true, true)[1]).toBe('human-steps');
  });

  it('keeps the usual place when nothing is due', () => {
    expect(viewSections(false, false).indexOf('human-steps')).toBe(viewSections(false, false).indexOf('choices') - 1);
  });

  it('counts only live, due work steps', () => {
    expect(hasDueSteps(undefined)).toBe(false);
    expect(hasDueSteps([step({ id: 'a', state: 'pending' }), step({ id: 'b', state: 'dismissed' })])).toBe(false);
    expect(hasDueSteps([step({ id: 'machine:merge', state: 'due' })])).toBe(false);
    expect(hasDueSteps([step({ id: 'a', state: 'due' })])).toBe(true);
  });
});
