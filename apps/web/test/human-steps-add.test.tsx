// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HumanSteps } from '../src/components/human-steps';
import { GLOB_VIEW_SECTIONS } from '../src/components/glob-view/sections';
import type { GlobView } from '../src/lib/api';
import { glob as coreGlob } from '../../../packages/core/test/fixtures';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const renderSteps = (onAdd = vi.fn(() => Promise.resolve(true))) => {
  const glob = { ...coreGlob(), list: 'planning', branch: 's1t1', currentRun: null, humanSteps: [] } as GlobView;
  render(
    <MemoryRouter>
      <HumanSteps glob={glob} canAdd onAdd={onAdd} onComplete={vi.fn(() => Promise.resolve(true))} onDismiss={vi.fn(() => Promise.resolve(true))} />
    </MemoryRouter>,
  );
  return onAdd;
};

describe('Human steps section', () => {
  it('sits directly above Choices', () => {
    expect(GLOB_VIEW_SECTIONS.indexOf('human-steps')).toBe(GLOB_VIEW_SECTIONS.indexOf('choices') - 1);
  });

  it('shows a "+ Add step" button in the title row even with no steps', () => {
    renderSteps();
    const button = screen.getByTestId('add-step');
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe('Add step');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.parentElement).toBe(screen.getByTestId('human-steps-toggle').closest('h3')?.parentElement);
  });

  it('toggles the add form and submits through onAdd', async () => {
    const user = userEvent.setup();
    const onAdd = renderSteps();
    expect(screen.queryByTestId('add-step-form')).toBeNull();
    await user.click(screen.getByTestId('add-step'));
    expect(screen.getByTestId('add-step-form')).not.toBeNull();
    await user.click(screen.getByTestId('add-step'));
    expect(screen.queryByTestId('add-step-form')).toBeNull();
    await user.click(screen.getByTestId('add-step'));
    await user.type(screen.getByTestId('step-title-input'), 'Rotate the key');
    await user.click(screen.getByTestId('add-step-submit'));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('add-step-form')).toBeNull();
  });

  it('opens a collapsed section when the button is clicked', async () => {
    const user = userEvent.setup();
    renderSteps();
    const toggle = screen.getByTestId('human-steps-toggle');
    if (toggle.getAttribute('aria-expanded') === 'true') await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByTestId('add-step'));
    expect(screen.getByTestId('human-steps-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('add-step-form')).not.toBeNull();
  });
});

describe('Human steps with long text', () => {
  it('wraps a long unbroken title and detail instead of widening the page', () => {
    const long = 'x'.repeat(200);
    const glob = {
      ...coreGlob(),
      list: 'planning',
      branch: 's1t1',
      currentRun: null,
      humanSteps: [{ id: 'hs1', title: long, detail: long, kind: 'manual', state: 'pending', who: 'anyone', due: 'after_merge', script: null }],
    } as unknown as GlobView;
    render(
      <MemoryRouter>
        <HumanSteps glob={glob} canAdd startOpen onAdd={vi.fn()} onComplete={vi.fn()} onDismiss={vi.fn()} />
      </MemoryRouter>,
    );
    const title = screen.getByTestId('step-title');
    expect(title.className).toContain('break-words');
    expect(title.className).toContain('min-w-0');
    expect(screen.getByTestId('human-step').className).toContain('min-w-0');
    expect(screen.getByTestId('human-steps').className).toContain('grid-cols-[minmax(0,1fr)]');
  });
});
