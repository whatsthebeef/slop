// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobMeta } from '../src/components/glob-view/meta';
import type { GlobViewContext } from '../src/components/glob-view/context';
import { glob } from '../../../packages/core/test/fixtures';

afterEach(cleanup);

const ctxOf = (over: Record<string, unknown>) =>
  ({
    board: { repo: null },
    glob: { ...glob(), generation: 1, runs: [], prs: [], pr: null, ...over },
  }) as unknown as GlobViewContext;

describe('GlobMeta', () => {
  it('has no Planner, Implementer, Created, Machine runs or Pull request rows', () => {
    const { queryByText } = render(
      <GlobMeta
        ctx={ctxOf({ implementer: 'a@b.c', planner: 'p@b.c', pr: { number: 3, state: 'draft' } })}
      />,
    );
    for (const label of ['Planner', 'Implementer', 'Created', 'Machine runs', 'Pull request'])
      expect(queryByText(label)).toBeNull();
  });
  it('renders nothing when there are no merged pull requests', () => {
    const { container } = render(<GlobMeta ctx={ctxOf({})} />);
    expect(container.firstChild).toBeNull();
  });
  it('lists merged pull requests when present', () => {
    const prs = [{ number: 7, mergeSha: 'abcdef1234', mergedAt: '2026-10-01T00:00:00Z' }];
    const { getByText } = render(<GlobMeta ctx={ctxOf({ prs })} />);
    expect(getByText('Merged and continued')).not.toBeNull();
    expect(getByText('#7')).not.toBeNull();
  });
});
