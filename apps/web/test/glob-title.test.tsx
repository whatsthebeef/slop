// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobTitle } from '../src/components/glob-title';

afterEach(cleanup);

const LONG = 'A very long title that would not fit on one line of the sticky header and so has to wrap over several lines';

const renderTitle = (props: Partial<Parameters<typeof GlobTitle>[0]> = {}) => {
  const onUpdate = vi.fn(() => Promise.resolve(null));
  const onEscape = vi.fn();
  render(
    <div onKeyDown={(e) => {
        if (e.key === 'Escape') onEscape();
      }}>
      <GlobTitle id='s1t1' title={LONG} editable onUpdate={onUpdate} onReload={() => Promise.resolve()} {...props} />
    </div>,
  );
  return { onUpdate, onEscape };
};

describe('GlobTitle', () => {
  it('wraps the full title when not editing: no truncation', () => {
    renderTitle();
    const text = screen.getByText(LONG);
    expect(text.className).toContain('break-words');
    expect(text.className).not.toContain('truncate');
  });

  it('wraps a title that cannot be edited too, with no edit affordance', () => {
    renderTitle({ editable: false });
    expect(screen.queryByTestId('glob-title-edit')).toBeNull();
    expect(screen.getByText(LONG).className).not.toContain('truncate');
  });

  it('edits in a textarea and Enter saves', async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderTitle();
    await user.click(screen.getByTestId('glob-title-edit'));
    const input = screen.getByTestId('glob-title-input');
    expect(input.tagName).toBe('TEXTAREA');
    await user.clear(input);
    await user.type(input, 'New title{Enter}');
    expect(onUpdate).toHaveBeenCalledWith({ title: 'New title' });
    await waitFor(() => expect(screen.queryByTestId('glob-title-input')).toBeNull());
  });

  it('cancels with Esc without saving and without the page seeing the key', async () => {
    const user = userEvent.setup();
    const { onUpdate, onEscape } = renderTitle();
    await user.click(screen.getByTestId('glob-title-edit'));
    await user.type(screen.getByTestId('glob-title-input'), ' more{Escape}');
    expect(screen.queryByTestId('glob-title-input')).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('has no pencil icon and hints at editing without one', () => {
    renderTitle();
    expect(document.body.querySelector('svg')).toBeNull();
    const edit = screen.getByTestId('glob-title-edit');
    expect(edit.getAttribute('title')).toBe('Click to edit');
    expect(edit.getAttribute('role')).toBe('button');
    expect(edit.getAttribute('aria-label')).toBe('Edit title');
    expect(edit.tabIndex).toBe(0);
  });

  it('starts editing on Enter for an editor', async () => {
    const user = userEvent.setup();
    renderTitle();
    screen.getByTestId('glob-title-edit').focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('glob-title-input')).toBeTruthy();
  });

  it('gives a non-editor no hint and no editing', async () => {
    const user = userEvent.setup();
    renderTitle({ editable: false });
    await user.click(screen.getByText(LONG));
    expect(screen.queryByTitle('Click to edit')).toBeNull();
    expect(screen.queryByTestId('glob-title-input')).toBeNull();
  });
});
