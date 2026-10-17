// @vitest-environment jsdom
import type { Notice as PresentedNotice } from '@slop/core';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { GlobViewContext } from '../src/components/glob-view/context';
import { Notice } from '../src/components/glob-view/notice';
import type { BoardView, GlobView } from '../src/lib/api';
import { board as coreBoard, glob } from '../../../packages/core/test/fixtures';

afterEach(cleanup);

const board: BoardView = { ...coreBoard, id: 3, role: 'dev' };
const view: GlobView = {
  ...glob(),
  id: 's1t7',
  boardId: 3,
  list: 'planning',
  branch: 's1t7',
  currentRun: null,
  conflict: null,
  failure: null,
};
const ctx: GlobViewContext = {
  board,
  glob: view,
  groups: [],
  busy: false,
  onAction: () => Promise.resolve(true),
  onUpdate: () => Promise.resolve(null),
  onOpenSection: () => undefined,
};

const show = (notice: PresentedNotice) =>
  render(
    <MemoryRouter>
      <Notice ctx={ctx} notice={notice} />
    </MemoryRouter>,
  );

describe('Notice: a failed build', () => {
  it("links the build log attachment in the glob view's Artifacts, not CodeBuild", () => {
    const { getByTestId, container } = show({
      kind: 'build-failed',
      text: 'Build failed on dev1: CodeBuild failed in BUILD',
      files: [],
      detail: null,
      url: null,
      attachment: 'Build log (dev1, failed, abc1234)',
    });
    const link = getByTestId('notice-attachment');
    expect(link.textContent).toBe('build log');
    expect(link.getAttribute('href')).toBe(
      '/boards/3/globs/s1t7?section=artifacts&artifact=attachment&label=Build+log+%28dev1%2C+failed%2C+abc1234%29',
    );
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
  });

  it('keeps the check run link for failed checks', () => {
    const { getByText, queryByTestId } = show({
      kind: 'checks',
      text: 'Checks failed',
      files: [],
      detail: null,
      url: 'https://ci/run/1',
      attachment: null,
    });
    expect(getByText('check run').getAttribute('href')).toBe('https://ci/run/1');
    expect(queryByTestId('notice-attachment')).toBeNull();
  });
});
