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
    pane({ category: 'feature,task,bug' });
    expect(screen.queryByTestId('filter-group-chip')).toBeNull();
    expect(screen.queryByTestId('filter-group')).toBeNull();
  });

  it('shows "Group: <name>" and removes only the group with the ×', async () => {
    const onChange = pane({ category: 'feature,task,bug', group: 'glob-groups' });
    expect(screen.getByTestId('filter-group-chip').textContent).toContain('Group: glob-groups');
    await userEvent.setup().click(screen.getByTestId('filter-group-remove'));
    expect(onChange).toHaveBeenCalledWith({ category: 'feature,task,bug', group: '' });
  });
});
