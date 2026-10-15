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
    expect(card.querySelector('[data-testid="step-why"]')?.textContent).toContain('Why:The buildspec declares an atf report group');
    expect(card.querySelector('[data-testid="step-permissions"]')?.textContent).toContain('An AWS session in the prod account');
    expect(card.querySelector('[data-testid="step-verify"]')?.textContent).toContain('The list shows the atf group');
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

  it('renders the step text as Markdown, with a copy button on code blocks', async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    show([
      step({
        id: 'a',
        state: 'due',
        detail: '**Why** `code`\n\n```\nmake ship\n```',
        why: 'Needs **admin** rights',
        permissions: 'Use `sudo`',
        verify: 'See **green**',
      }),
    ]);
    const card = screen.getByTestId('due-step');
    expect(card.textContent).not.toMatch(/\*\*|`/);
    expect(card.querySelectorAll('strong')).toHaveLength(3);
    expect(card.querySelectorAll('code').length).toBeGreaterThanOrEqual(2);
    await userEvent.click(card.querySelector('[data-testid="step-code-copy"]') as HTMLElement);
    expect(write).toHaveBeenCalledWith('make ship');
  });

  it('shows a step title as plain text with no Markdown markers', () => {
    show([step({ id: 'a', state: 'due', title: 'Run **the** `thing`' })]);
    expect(screen.getByTestId('step-title').textContent).toBe('Run the thing');
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
  it('puts the due steps block with the other blocks that need a person, and leaves More steps with the collapsibles', () => {
    const order = viewSections(false, true);
    expect(order.indexOf('due-steps')).toBe(order.indexOf('escalation') - 1);
    expect(order.indexOf('due-steps')).toBeGreaterThan(order.indexOf('labels'));
    expect(order.indexOf('due-steps')).toBeLessThan(order.indexOf('actions'));
    expect(order.indexOf('human-steps')).toBeGreaterThan(order.indexOf('actions'));
    expect(new Set(order).size).toBe(order.length);
    const decision = viewSections(true, true);
    expect(decision.indexOf('due-steps')).toBeGreaterThan(decision.indexOf('decision'));
    expect(decision.indexOf('due-steps')).toBe(decision.indexOf('escalation') - 1);
    expect(decision.indexOf('human-steps')).toBeGreaterThan(decision.indexOf('actions'));
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

describe('the two parts of the Human steps', () => {
  const split = (part: 'due' | 'rest', humanSteps: ListedHumanStep[]) => {
    const glob = { ...coreGlob(), list: 'doing', branch: 's1t1', currentRun: null, humanSteps } as GlobView;
    render(
      <MemoryRouter>
        <HumanSteps part={part} glob={glob} canAdd onAdd={vi.fn(() => Promise.resolve(true))} onComplete={vi.fn(() => Promise.resolve(true))} onDismiss={vi.fn(() => Promise.resolve(true))} />
      </MemoryRouter>,
    );
  };

  it('the due part holds only the due-steps block, with the step text once', () => {
    split('due', [step({ id: 'a', state: 'due', detail: 'Why: x' })]);
    expect(screen.getByTestId('due-steps').textContent).toContain('Why: x');
    expect(screen.queryByTestId('human-steps-toggle')).toBeNull();
    expect(screen.queryByTestId('add-step')).toBeNull();
  });

  it('the rest part holds the More steps toggle and Add step, not the due block', () => {
    split('rest', [step({ id: 'a', state: 'due' })]);
    expect(screen.queryByTestId('due-steps')).toBeNull();
    expect(screen.getByTestId('human-steps-toggle').textContent).toContain('More steps (0)');
    expect(screen.getByTestId('add-step')).not.toBeNull();
  });
});
