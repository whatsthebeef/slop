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
  it('is a needs-a-person block of the shared family: head with the count, the steps as its body, no Markdown', () => {
    show([step({ id: 'a', state: 'due', detail: 'Do this: **run** it' })]);
    const block = screen.getByTestId('due-steps');
    expect(block.getAttribute('data-block')).toBe('person');
    expect(block.querySelector('[data-testid="block-head"]')?.textContent).toBe('A step needs you');
    expect(block.querySelector('[data-testid="block-body"] [data-testid="due-step"]')).not.toBeNull();
  });

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
    // With the other blocks that need a person (after the labels), before the information blocks.
    expect(order.indexOf('human-steps')).toBe(order.indexOf('escalation') - 1);
    expect(order.indexOf('human-steps')).toBeGreaterThan(order.indexOf('labels'));
    expect(order.indexOf('human-steps')).toBeLessThan(order.indexOf('actions'));
    expect(new Set(order).size).toBe(order.length);
    const decision = viewSections(true, true);
    expect(decision.indexOf('human-steps')).toBeGreaterThan(decision.indexOf('decision'));
    expect(decision.indexOf('human-steps')).toBe(decision.indexOf('escalation') - 1);
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
