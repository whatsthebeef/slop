// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityLog } from '../src/components/glob-view/activity';
import type { GlobViewContext } from '../src/components/glob-view/context';
import type { NowState } from '../src/components/glob-view/status';
import type { GlobActionsState } from '../src/components/glob-view/actions';
import * as activity from '../src/lib/activity';
import { vi } from 'vitest';

afterEach(cleanup);

describe('Activity log with long text', () => {
  it('keeps an entry on one truncated line with the full text in its tooltip', () => {
    const long = 'y'.repeat(300);
    vi.spyOn(activity, 'activityOf').mockReturnValue([
      { id: 'e1', actor: 'machine', text: long, at: null, link: null, linkLabel: '', title: long, count: 1, command: null },
    ]);
    const ctx = { board: { repo: 'o/r' }, glob: { id: 's1t1', pr: null } } as unknown as GlobViewContext;
    const state = { move: null, turn: null, steps: [], brief: null, problem: null, turnDismissed: false } as unknown as NowState;
    render(
      <MemoryRouter>
        <ActivityLog ctx={ctx} state={state} actions={{ busy: false } as unknown as GlobActionsState} />
      </MemoryRouter>,
    );
    const entry = screen.getByTestId('activity-entry');
    expect(entry.getAttribute('title')).toBe(long);
    expect(entry.querySelector('.truncate')).not.toBeNull();
    expect(entry.className).toContain('min-w-0');
    expect(screen.getByTestId('activity-feed').className).toContain('grid-cols-[minmax(0,1fr)]');
  });
});
