// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LabelChips, LabelPopover } from '../src/components/labels';
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

describe('outstanding label chips', () => {
  const item = (id: string, done: boolean) => ({
    id,
    text: id,
    done,
    addedBy: 'a',
    doneBy: done ? 'b' : null,
  });
  const withLabels = (
    labels: Record<string, string>,
    checklists: Record<string, ReturnType<typeof item>[]>,
  ) => ({ ...glob(), labels, checklists }) as unknown as GlobView;
  const chipOf = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll('span')].find((e) => e.textContent === name) as HTMLElement;

  const places = {
    card: (g: GlobView) =>
      render(<LabelPopover glob={g} onReview={vi.fn()} onOpenReview={vi.fn()} />).container,
    'glob view': (g: GlobView) => render(<LabelChips glob={g} />).container,
  };

  for (const [where, draw] of Object.entries(places)) {
    it(`shows an open item as filled deep red with white text on the ${where}, whatever the stored state`, () => {
      for (const state of ['required', 'added']) {
        cleanup();
        const c = draw(withLabels({ QA: state }, { QA: [item('x', false)] }));
        expect(chipOf(c, 'QA').className).toContain('bg-outstanding');
        expect(chipOf(c, 'QA').className).toContain('text-outstanding-foreground');
      }
    });

    it(`keeps required with no items brown and approved green on the ${where}`, () => {
      const c = draw(
        withLabels({ FR: 'required', QA: 'approved' }, { FR: [], QA: [item('x', false)] }),
      );
      expect(chipOf(c, 'FR').className).toContain('text-required');
      expect(chipOf(c, 'FR').className).not.toContain('bg-outstanding');
      expect(chipOf(c, 'QA').className).toContain('bg-lcd');
    });

    it(`drops the red once the last item is ticked on the ${where}`, () => {
      const c = draw(withLabels({ QA: 'added' }, { QA: [item('x', true)] }));
      expect(chipOf(c, 'QA').className).not.toContain('bg-outstanding');
    });
  }
});
