// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupView } from '@slop/core';
import { GroupPageView } from '../src/pages/group';
import type { GroupActions } from '../src/pages/group';
import { GlobCard } from '../src/components/glob-card';
import { glob } from '../../../packages/core/test/fixtures';
import type { GlobView } from '../src/lib/api';

afterEach(cleanup);

const view: GroupView = {
  name: 'board-chat',
  progress: { merged: 1, total: 2 },
  counts: { signed_off: 1, planning: 1 },
  lastActivityAt: null,
  globs: [
    { id: 's1t1', title: 'Chat API', status: 'signed_off', type: 'sub', updatedAt: '', move: { holder: 'done', reason: 'Signed off', since: null }, holding: [] },
    {
      id: 's1t2',
      title: 'Chat UI',
      status: 'planning',
      type: 'sub',
      updatedAt: '',
      move: { holder: 'waiting', reason: 'waiting on s1k9', since: null },
      holding: [{ relationId: 'r2', to: 's1k9', toTitle: 'Pick a model', toIsDecision: true, gate: 'start', until: 'decided', state: 'open', reason: null, source: 'person' }],
    },
  ],
  relations: [
    { id: 'r2', from: 's1t2', to: 's1k9', toTitle: 'Pick a model', toIsDecision: true, gate: 'start', until: 'decided', state: 'open', reason: null, source: 'person', holding: true, crosses: false },
    { id: 'r3', from: 's1t2', to: 's2t7', toTitle: 'Elsewhere', toIsDecision: false, gate: 'merge', until: 'merged', state: 'merged', reason: null, source: 'person', holding: false, crosses: true },
  ],
  decisions: [{ id: 's1k9', title: 'Pick a model', holdsBack: ['s1t2'] }],
};

const actions = (): GroupActions => ({
  onRename: vi.fn(() => Promise.resolve(null)),
  onMerge: vi.fn(() => Promise.resolve(null)),
  onMoveOut: vi.fn(() => Promise.resolve(null)),
  onMoveIn: vi.fn(() => Promise.resolve(null)),
  onAdd: vi.fn(),
});

const show = (a = actions()) => {
  render(
    <MemoryRouter>
      <GroupPageView boardId={1} view={view} others={[]} candidates={[{ id: 's1t8', title: 'Loose' }]} actions={a} />
    </MemoryRouter>,
  );
  return a;
};

describe('group page', () => {
  it('shows the name, progress, globs with who holds them, relations and open decisions', () => {
    show();
    expect(screen.getByTestId('group-name').textContent).toBe('board-chat');
    expect(screen.getByTestId('group-progress').textContent).toBe('1/2 merged');
    expect(screen.getByTestId('group-glob-s1t2-move').textContent).toContain('waiting');
    expect(within(screen.getByTestId('group-glob-s1t2')).getByRole('link', { name: 's1t2' }).getAttribute('href')).toBe('/boards/1/globs/s1t2');
    const relations = screen.getByTestId('group-relations');
    expect(within(screen.getByTestId('group-relation-r2')).queryByTestId('relation-crosses')).toBeNull();
    expect(within(screen.getByTestId('group-relation-r3')).getByTestId('relation-crosses')).toBeTruthy();
    expect(within(relations).getAllByRole('listitem')[0]?.getAttribute('data-testid')).toBe('group-relation-r2');
    expect(within(screen.getByTestId('group-decisions')).getByText(/Holds back s1t2 Chat UI/)).toBeTruthy();
    expect(screen.queryByText(/sign-off$/i)).toBeNull();
  });

  it('moves a glob out, moves one in, and opens Add glob', async () => {
    const a = show();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Move s1t2 out of the group' }));
    expect(a.onMoveOut).toHaveBeenCalledWith('s1t2');
    await user.selectOptions(screen.getByLabelText('Glob to move into the group'), 's1t8');
    await user.click(screen.getByRole('button', { name: 'Move in' }));
    expect(a.onMoveIn).toHaveBeenCalledWith('s1t8');
    await user.click(screen.getByRole('button', { name: 'Add glob' }));
    expect(a.onAdd).toHaveBeenCalled();
  });

  it('renames and shows an error from an action', async () => {
    const a = actions();
    a.onRename = vi.fn(() => Promise.resolve('That name is taken'));
    show(a);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename group' }));
    const input = screen.getByLabelText('New group name');
    await user.clear(input);
    await user.type(input, 'chat');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(a.onRename).toHaveBeenCalledWith('chat');
    expect((await screen.findByTestId('group-error')).textContent).toBe('That name is taken');
  });
});

describe('group page merge', () => {
  it('merges into the chosen group', async () => {
    const a = actions();
    render(
      <MemoryRouter>
        <GroupPageView
          boardId={1}
          view={view}
          others={[{ name: 'chat-v2', progress: { merged: 0, total: 1 }, open: 1, counts: {}, lastActivityAt: null }]}
          candidates={[]}
          actions={a}
        />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Merge' }).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText('Group to merge into'), 'chat-v2');
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(a.onMerge).toHaveBeenCalledWith('chat-v2');
  });
});

describe('card group label', () => {
  const card = (props: { onFilterGroup?: (n: string) => void }) =>
    render(
      <MemoryRouter>
        <GlobCard
          glob={{ ...glob(), group: 'board-chat' } as GlobView}
          onOpen={vi.fn()}
          onOpenSection={vi.fn()}
          moves={[]}
          previewing={null}
          onPreview={vi.fn()}
          onMove={vi.fn()}
          onArrow={vi.fn()}
          {...props}
        />
      </MemoryRouter>,
    );

  it('filters the board by the group on click, with no progress and no link to the group page', async () => {
    const onFilterGroup = vi.fn();
    card({ onFilterGroup });
    const chip = screen.getByTestId('group-chip');
    expect(chip.textContent).toBe('board-chat');
    expect(chip.getAttribute('href')).toBeNull();
    expect(screen.getAllByTestId('group-chip')).toHaveLength(1);
    await userEvent.setup().click(chip);
    expect(onFilterGroup).toHaveBeenCalledWith('board-chat');
  });
});
