// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterPane } from '../src/components/board-filter-pane';

afterEach(cleanup);

describe('filter pane group chip', () => {
  const pane = (values: Record<string, string>, onChange = vi.fn()) => {
    render(<FilterPane open values={values} onChange={onChange} onClose={vi.fn()} />);
    return onChange;
  };

  it('shows no group chip or control while the group filter is off', () => {
    pane({ mode: 'sub,same,super' });
    expect(screen.queryByTestId('filter-group-chip')).toBeNull();
    expect(screen.queryByTestId('filter-group')).toBeNull();
  });

  it('shows "Group: <name>" and removes only the group with the ×', async () => {
    const onChange = pane({ mode: 'sub,same,super', group: 'glob-groups' });
    expect(screen.getByTestId('filter-group-chip').textContent).toContain('Group: glob-groups');
    await userEvent.setup().click(screen.getByTestId('filter-group-remove'));
    expect(onChange).toHaveBeenCalledWith({ mode: 'sub,same,super', group: '' });
  });
});

describe('filter pane Only human toggle', () => {
  it('shows the toggle off by default and turns it on and off', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterPane open values={{ mode: 'sub,same,super' }} onChange={onChange} onClose={vi.fn()} />);
    const toggle = screen.getByTestId('filter-human');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await userEvent.setup().click(toggle);
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'sub,same,super', human: '1' });
    rerender(<FilterPane open values={{ mode: 'sub,same,super', human: '1' }} onChange={onChange} onClose={vi.fn()} />);
    expect(screen.getByTestId('filter-human').getAttribute('aria-pressed')).toBe('true');
    await userEvent.setup().click(screen.getByTestId('filter-human'));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'sub,same,super', human: '' });
  });
});

describe('filter pane Arm system toggle', () => {
  it('shows the toggle with a rocket, off by default, and turns it on and off', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterPane open values={{ mode: 'sub,same,super' }} onChange={onChange} onClose={vi.fn()} />);
    const toggle = screen.getByTestId('filter-arm');
    expect(toggle.textContent).toBe('Arm system');
    expect(toggle.querySelector('svg.lucide-rocket')).not.toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await userEvent.setup().click(toggle);
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'sub,same,super', arm: '1' });
    rerender(<FilterPane open values={{ mode: 'sub,same,super', arm: '1' }} onChange={onChange} onClose={vi.fn()} />);
    expect(screen.getByTestId('filter-arm').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('filter pane text filter', () => {
  const show = () => render(<FilterPane open values={{ mode: 'sub,same,super,action' }} onChange={vi.fn()} onClose={vi.fn()} />);

  it('is the last control in the pane and wide enough for its placeholder', () => {
    show();
    const text = screen.getByTestId('filter-id');
    const controls = [...screen.getByTestId('filter-pane').querySelectorAll('input, button:not([data-testid="filter-close"])')];
    expect(controls.at(-1)).toBe(text);
    expect(text.className).toContain('w-64');
  });

  it('keeps its id and the / shortcut hint', () => {
    show();
    const text = screen.getByTestId('filter-id');
    expect(text.id).toBe('board-filter-text');
    expect(text.getAttribute('aria-keyshortcuts')).toBe('/');
  });
});
