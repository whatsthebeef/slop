// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobMeta } from '../src/components/glob-view/meta';
import type { GlobViewContext } from '../src/components/glob-view/context';
import { glob } from '../../../packages/core/test/fixtures';

afterEach(cleanup);

const implementerCell = (over: Record<string, unknown>) => {
  const ctx = {
    board: { repo: null },
    glob: { ...glob(), generation: 1, runs: [], prs: [], pr: null, ...over },
  } as unknown as GlobViewContext;
  cleanup();
  const { getByText } = render(<GlobMeta ctx={ctx} />);
  return getByText('Implementer').nextElementSibling as HTMLElement;
};
const run = (over: Record<string, unknown>) => ({
  id: 'r',
  generation: 1,
  routineOwner: 'a@b.c',
  ...over,
});

describe('GlobMeta sections', () => {
  it('has no Machine runs or Pull request section', () => {
    const ctx = {
      board: { repo: null },
      glob: {
        ...glob(),
        generation: 1,
        runs: [run({})],
        prs: [],
        pr: { number: 3, state: 'draft' },
      },
    } as unknown as GlobViewContext;
    const { queryByText } = render(<GlobMeta ctx={ctx} />);
    expect(queryByText('Pull request')).toBeNull();
    expect(queryByText('Machine runs')).toBeNull();
  });
});

describe('GlobMeta implementer', () => {
  it('shows a person with the human icon', () => {
    const cell = implementerCell({ implementer: 'a@b.c' });
    expect(cell.textContent).toBe('a@b.c');
    expect(cell.querySelector('[aria-hidden]')).not.toBeNull();
  });
  it('shows Machine when a machine run exists in the current generation', () => {
    expect(implementerCell({ implementer: null, runs: [run({})] }).textContent).toBe('Machine');
  });
  it('shows Machine for slop', () => {
    expect(implementerCell({ implementer: 'slop' }).textContent).toBe('Machine');
  });
  it('shows a dash when nobody has started, or only investigated / an older generation ran', () => {
    expect(implementerCell({ implementer: null }).textContent).toBe('—');
    expect(
      implementerCell({ implementer: null, runs: [run({ purpose: 'investigate' })] }).textContent,
    ).toBe('—');
    expect(implementerCell({ implementer: null, runs: [run({ generation: 0 })] }).textContent).toBe(
      '—',
    );
  });
});
