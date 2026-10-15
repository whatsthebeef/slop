// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HumanSteps } from '../src/components/human-steps';
import type { GlobView, ListedHumanStep } from '../src/lib/api';
import { dismissalText } from '../src/lib/human-steps';
import { needsRelease } from '../src/lib/human-steps';
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

const renderSteps = (humanSteps: ListedHumanStep[]) => {
  const glob = { ...coreGlob(), list: 'planning', branch: 's1t1', currentRun: null, humanSteps } as GlobView;
  render(
    <MemoryRouter>
      <HumanSteps glob={glob} canAdd startOpen onAdd={vi.fn(() => Promise.resolve(true))} onComplete={vi.fn(() => Promise.resolve(true))} onDismiss={vi.fn(() => Promise.resolve(true))} />
    </MemoryRouter>,
  );
};

const dismissed = (id: string, reason: string): ListedHumanStep =>
  step({ id, state: 'dismissed', dismissedReason: reason, doneBy: 'ann@x.com', doneAt: '2026-10-15T09:00:00.000Z' });

describe('Dismissed human steps', () => {
  it('collapses dismissed steps into one "N dismissed" line; open and done steps stay listed and the heading ignores dismissed ones', () => {
    renderSteps([step({ id: 'a', state: 'due' }), step({ id: 'b', state: 'done' }), dismissed('c', 'wrong'), dismissed('d', 'dup')]);
    expect(screen.getAllByTestId('due-step')).toHaveLength(1);
    expect(screen.getAllByTestId('human-step')).toHaveLength(1);
    expect(screen.getByTestId('dismissed-toggle').textContent).toBe('2 dismissed ▸');
    expect(screen.queryAllByTestId('dismissed-step')).toHaveLength(0);
    expect(screen.getByTestId('human-steps-toggle').textContent).toContain('More steps (1)');
  });

  it('expands to each dismissed step with its reason, who and when', async () => {
    renderSteps([step({ id: 'a', state: 'due' }), dismissed('c', 'wrong host')]);
    await userEvent.click(screen.getByTestId('dismissed-toggle'));
    expect(screen.getByTestId('dismissed-toggle').textContent).toBe('1 dismissed ▾');
    expect(screen.getByTestId('dismissed-title').textContent).toBe('Step c');
    expect(screen.getByTestId('dismissed-reason').textContent).toBe(': wrong host');
    expect(screen.getByTestId('dismissed-who').textContent).toBe(' (by ann@x.com on 2026-10-15)');
  });

  it('renders a dismissal reason as Markdown, with no raw markers', async () => {
    renderSteps([step({ id: 'a', state: 'due' }), dismissed('c', 'wrong **host**, use `h2`')]);
    await userEvent.click(screen.getByTestId('dismissed-toggle'));
    const reason = screen.getByTestId('dismissed-reason');
    expect(reason.textContent).toBe(': wrong host, use h2');
    expect(reason.querySelector('strong')?.textContent).toBe('host');
    expect(reason.querySelector('code')?.textContent).toBe('h2');
  });

  it('shows no dismissed line when nothing is dismissed', () => {
    renderSteps([step({ id: 'a', state: 'due' })]);
    expect(screen.queryByTestId('dismissed-steps')).toBeNull();
  });

  it('does not count dismissed steps toward the card (Arm system)', () => {
    expect(needsRelease([dismissed('c', 'x')])).toBeNull();
  });

  it('words who and when, leaving out what an older dismissal lacks', () => {
    expect(dismissalText({ doneBy: null, doneAt: null })).toBe('');
    expect(dismissalText({ doneBy: 'slop', doneAt: null })).toBe('by slop');
  });
});
