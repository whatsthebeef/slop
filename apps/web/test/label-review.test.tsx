// @vitest-environment jsdom
import { machine } from '@slop/core';
import type { LabelCommand, LabelName } from '@slop/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LabelPopover, LabelReviews } from '../src/components/labels';
import type { GlobView } from '../src/lib/api';
import { ctx, glob } from '../../../packages/core/test/fixtures';

afterEach(cleanup);
beforeEach(() => {
  // jsdom has no layout: Radix and the review's scroll-into-view need these.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const start = (labels: GlobView['labels'] = { CR: 'required', FR: 'required', QA: 'required' }) =>
  ({ ...glob({ status: 'reviewing', labels }), checklists: {} }) as unknown as GlobView;

/** A fake server: commands run through the real machine, and the saved glob outlives a remount. */
const server = (initial: GlobView) => {
  let current = initial;
  const calls: [LabelName, LabelCommand][] = [];
  return {
    calls,
    get glob() {
      return current;
    },
    review: (label: LabelName, command: LabelCommand) => {
      calls.push([label, command]);
      const result = machine.reviewLabel(current, label, command, ctx());
      if (!result.ok) return Promise.resolve(false);
      current = {
        ...current,
        ...result.value.glob,
        version: current.version + 1,
      };
      return Promise.resolve(true);
    },
  };
};

const Host = ({ api, popover = false }: { api: ReturnType<typeof server>; popover?: boolean }) => {
  const [, setTick] = useState(0);
  const onReview = async (label: LabelName, command: LabelCommand) => {
    const ok = await api.review(label, command);
    setTick((t) => t + 1);
    return ok;
  };
  return popover ? (
    <LabelPopover glob={api.glob} onReview={onReview} onOpenReview={vi.fn()} />
  ) : (
    <LabelReviews glob={api.glob} onReview={onReview} />
  );
};

const confirmButton = () => {
  const found = screen.getAllByRole('button', { name: 'Approve anyway' });
  return found[found.length - 1] ?? within(document.body).getByText('missing');
};
const CR = () => screen.getByTestId('review-CR');
const field = () => screen.getByLabelText(/^CR item \d+$/);

describe('the sign-off block', () => {
  it('is a needs-a-person block of the shared family with one card per label as its body', () => {
    render(<Host api={server(start())} />);
    const block = screen.getByTestId('label-reviews');
    expect(block.getAttribute('data-block')).toBe('person');
    expect(block.querySelector('[data-testid="block-head"]')?.textContent).toBe('Sign-off');
    expect(block.querySelectorAll('[data-testid="block-body"] > [data-testid^="review-"]')).toHaveLength(3);
  });
});

describe('typing review items', () => {
  it('Enter saves a draft, shows it read-only and opens a fresh focused field', async () => {
    const api = server(start());
    render(<Host api={api} />);
    const user = userEvent.setup();
    await user.type(field(), 'Fix copy{Enter}');
    expect(api.calls).toEqual([['CR', { kind: 'save_draft_item', text: 'Fix copy' }]]);
    expect(await screen.findByRole('button', { name: 'Fix copy' })).toBeTruthy();
    expect(screen.queryByDisplayValue('Fix copy')).toBeNull();
    await waitFor(() => expect((field() as HTMLInputElement).value).toBe(''));
    expect(document.activeElement).toBe(field());
  });

  it('an empty Enter does nothing', async () => {
    const api = server(start());
    render(<Host api={api} />);
    const user = userEvent.setup();
    await user.type(field(), '   {Enter}');
    expect(api.calls).toEqual([]);
  });

  it('+ Add another saves the typed text like Enter', async () => {
    const api = server(start());
    render(<Host api={api} />);
    const user = userEvent.setup();
    await user.click(within(CR()).getByRole('button', { name: '+ Add another' }));
    expect(api.calls).toEqual([]);
    await user.type(field(), 'One');
    await user.click(within(CR()).getByRole('button', { name: '+ Add another' }));
    expect(api.calls).toEqual([['CR', { kind: 'save_draft_item', text: 'One' }]]);
    expect(await screen.findByRole('button', { name: 'One' })).toBeTruthy();
  });

  it('clicking a saved item edits it: Enter saves, Escape cancels', async () => {
    const api = server(start());
    render(<Host api={api} />);
    const user = userEvent.setup();
    await user.type(field(), 'Fix copy{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Fix copy' }));
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('button', { name: 'Fix copy' })).toBeTruthy();
    expect(api.calls).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Fix copy' }));
    await user.type(screen.getByLabelText('Edit CR item 1'), ' now{Enter}');
    expect(api.calls[1]).toEqual([
      'CR',
      { kind: 'save_draft_item', text: 'Fix copy now', itemId: '1' },
    ]);
    expect(await screen.findByRole('button', { name: 'Fix copy now' })).toBeTruthy();
  });

  it('blur saves an edit', async () => {
    const api = server(start());
    render(<Host api={api} />);
    const user = userEvent.setup();
    await user.type(field(), 'a{Enter}');
    await user.click(await screen.findByRole('button', { name: 'a' }));
    await user.type(screen.getByLabelText('Edit CR item 1'), 'b');
    await user.click(field());
    expect(api.calls[1]).toEqual(['CR', { kind: 'save_draft_item', text: 'ab', itemId: '1' }]);
  });

  it('the ✕ removes a draft', async () => {
    const api = server(start());
    render(<Host api={api} />);
    const user = userEvent.setup();
    await user.type(field(), 'gone{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Remove CR item 1' }));
    expect(api.calls[1]).toEqual(['CR', { kind: 'remove_draft_item', itemId: '1' }]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'gone' })).toBeNull());
  });

  it('drafts persist across a remount', async () => {
    const api = server(start());
    const first = render(<Host api={api} />);
    await userEvent.setup().type(field(), 'kept{Enter}');
    await screen.findByRole('button', { name: 'kept' });
    first.unmount();
    render(<Host api={api} />);
    expect(screen.getByRole('button', { name: 'kept' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send 1 item' })).toBeTruthy();
  });
});

describe('sending items', () => {
  it('Send N items is disabled with nothing to send, then sends the drafts', async () => {
    const api = server(start());
    render(<Host api={api} />);
    const user = userEvent.setup();
    expect(
      within(CR()).getByRole<HTMLButtonElement>('button', { name: 'Send 0 items' }).disabled,
    ).toBe(true);
    await user.type(field(), 'a{Enter}');
    await user.type(field(), 'b{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Send 2 items' }));
    expect(api.calls.at(-1)).toEqual(['CR', { kind: 'send_items' }]);
    expect(api.glob.labels.CR).toBe('added');
    expect(await screen.findByText(/Items added · 0 of 2 done/)).toBeTruthy();
  });

  it('text typed but not saved goes along with the drafts', async () => {
    const api = server(start());
    render(<Host api={api} />);
    const user = userEvent.setup();
    await user.type(field(), 'a{Enter}');
    await user.type(field(), 'b');
    await user.click(await screen.findByRole('button', { name: 'Send 2 items' }));
    expect(api.calls.at(-1)).toEqual(['CR', { kind: 'submit_items', items: ['b'] }]);
    expect(api.glob.checklists.CR?.map((i) => [i.text, i.draft])).toEqual([
      ['a', undefined],
      ['b', undefined],
    ]);
  });
});

describe('approving', () => {
  const approve = (name: string) => within(CR()).getByRole('button', { name });

  it('with no open items says Approve, outlined, and approves at once', async () => {
    const api = server(start());
    render(<Host api={api} />);
    const button = approve('Approve');
    expect(button.className).not.toContain('bg-primary');
    expect(button.className).toContain('bg-card');
    await userEvent.setup().click(button);
    expect(api.calls).toEqual([['CR', { kind: 'approve' }]]);
  });

  it('with unsent drafts says Approve anyway, asks first and discards them', async () => {
    const api = server(start());
    render(<Host api={api} />);
    const user = userEvent.setup();
    await user.type(field(), 'a{Enter}');
    await user.type(field(), 'b{Enter}');
    const button = await screen.findByRole('button', { name: 'Approve anyway' });
    expect(button.className).not.toContain('bg-primary');
    await user.click(button);
    expect(await screen.findByText(/2 items are still open\. Approve anyway\?/)).toBeTruthy();
    expect(screen.getByText(/Unsent drafts will be discarded/)).toBeTruthy();
    expect(api.calls.every(([, c]) => c.kind !== 'approve')).toBe(true);
    await user.click(confirmButton());
    expect(api.calls.at(-1)).toEqual(['CR', { kind: 'approve' }]);
    expect(api.glob.labels.CR).toBe('approved');
    expect(api.glob.checklists.CR).toEqual([]);
  });

  it('cancelling the confirmation approves nothing', async () => {
    const api = server(start());
    render(<Host api={api} />);
    const user = userEvent.setup();
    await user.type(field(), 'a{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Approve anyway' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(api.calls.every(([, c]) => c.kind !== 'approve')).toBe(true);
  });

  it('with unticked items asks first, without mentioning drafts', async () => {
    const api = server(start());
    await api.review('CR', { kind: 'submit_items', items: ['one', 'two'] });
    render(<Host api={api} />);
    const user = userEvent.setup();
    await user.click(approve('Approve anyway'));
    expect(await screen.findByText(/2 items are still open\. Approve anyway\?/)).toBeTruthy();
    expect(screen.queryByText(/Unsent drafts/)).toBeNull();
  });

  it('a resubmitted label with an unticked item also asks first', async () => {
    const api = server(start());
    await api.review('CR', { kind: 'submit_items', items: ['one'] });
    await api.review('CR', { kind: 'resubmit' });
    render(<Host api={api} />);
    await userEvent.setup().click(approve('Approve anyway'));
    expect(await screen.findByText(/1 item is still open\. Approve anyway\?/)).toBeTruthy();
    expect(screen.queryByText(/Unsent drafts/)).toBeNull();
  });

  it('the card popover follows the same rule', async () => {
    const api = server(start({ CR: 'required', QA: 'required' }));
    await api.review('CR', { kind: 'save_draft_item', text: 'x' });
    render(<Host api={api} popover />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Sign-off labels'));
    const plain = screen.getByRole('button', { name: 'Approve' });
    expect(plain.className).toContain('bg-card');
    await user.click(screen.getByRole('button', { name: 'Approve anyway' }));
    expect(await screen.findByText(/1 item is still open\. Approve anyway\?/)).toBeTruthy();
    await user.click(confirmButton());
    expect(api.calls.at(-1)).toEqual(['CR', { kind: 'approve' }]);
  });

  it('clicks in the confirmation dialog do not reach the card around the popover', async () => {
    const api = server(start({ CR: 'required' }));
    await api.review('CR', { kind: 'save_draft_item', text: 'x' });
    const onCard = vi.fn();
    render(
      <div onClick={onCard}>
        <Host api={api} popover />
      </div>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Sign-off labels'));
    await user.click(screen.getByRole('button', { name: 'Approve anyway' }));
    onCard.mockClear();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onCard).not.toHaveBeenCalled();
  });

  it('drafts are not counted as items in the state text', async () => {
    const api = server(start());
    await api.review('CR', { kind: 'save_draft_item', text: 'x' });
    render(<Host api={api} />);
    expect(CR().textContent).toContain('Waiting for review');
  });
});
