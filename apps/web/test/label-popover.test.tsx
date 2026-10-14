// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LabelPopover } from '../src/components/labels';
import type { GlobView } from '../src/lib/api';
import { glob } from '../../../packages/core/test/fixtures';

afterEach(cleanup);

const view = (): GlobView =>
  ({
    ...glob(),
    labels: { CR: 'required', FR: 'required', QA: 'approved' },
    checklists: { CR: [], FR: [], QA: [] },
  }) as unknown as GlobView;

describe('card label popover', () => {
  const open = async (onOpenReview = vi.fn()) => {
    render(<LabelPopover glob={view()} onReview={vi.fn()} onOpenReview={onOpenReview} />);
    await userEvent.setup().click(screen.getByLabelText('Sign-off labels'));
    return onOpenReview;
  };

  it('shows the acronyms without full names or the waiting text', async () => {
    await open();
    const text = screen.getByRole('button', { name: 'Open review checklist' }).parentElement
      ?.textContent;
    expect(text).toContain('CR');
    expect(text).not.toContain('Code review');
    expect(text).not.toContain('Functional review');
    expect(text).not.toContain('Waiting for review');
  });

  it('sizes to its content with compact padding', async () => {
    await open();
    const content = screen
      .getByRole('button', { name: 'Open review checklist' })
      .closest('[class*="p-2"]');
    expect(content?.className).toContain('w-auto');
    expect(content?.className).toContain('p-2');
    expect(content?.className).not.toContain('w-80');
    expect(content?.querySelectorAll(':scope *:empty:not(button *)').length).toBe(0);
  });

  it('keeps the Open review checklist link', async () => {
    const onOpenReview = await open();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open review checklist' }));
    expect(onOpenReview).toHaveBeenCalledWith();
  });
});

describe('card label popover width', () => {
  it('reserves the same room after each label whether required or approved', async () => {
    const collect = async (state: 'required' | 'approved') => {
      const g = {
        ...glob(),
        labels: { CR: state, FR: state, QA: state },
        checklists: { CR: [], FR: [], QA: [] },
      } as unknown as GlobView;
      render(<LabelPopover glob={g} onReview={vi.fn()} onOpenReview={vi.fn()} />);
      await userEvent.setup().click(screen.getByLabelText('Sign-off labels'));
      const reserved = [...document.querySelectorAll('[data-reserved-action]')].map(
        (e) => e.textContent,
      );
      const states = [...document.querySelectorAll('[data-reserved-state="approved"]')].map(
        (e) => e.textContent,
      );
      cleanup();
      return { reserved, states };
    };
    const required = await collect('required');
    const approved = await collect('approved');
    expect(required.reserved).toEqual(['Approve anyway', 'Approve anyway', 'Approve anyway']);
    expect(required).toEqual(approved);
    expect(required.states).toEqual(['Approved', 'Approved', 'Approved']);
  });
});
