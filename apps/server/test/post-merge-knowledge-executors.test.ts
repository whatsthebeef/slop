import { LlmUnavailable } from '@slop/core';
import type { Board, Effect, Glob, PostMergeKnowledgeService } from '@slop/core';
import { describe, expect, it, vi } from 'vitest';
import {
  HostSpecReader,
  postMergeKnowledgeExecutors,
} from '../src/post-merge-knowledge-executors.js';

const board = { id: 1, repo: 'o/r', baseBranch: 'main' } as unknown as Board;
const effect: Effect = {
  kind: 'post_merge_knowledge',
  globId: 's1t1',
  generation: 1,
  sha: 'abc1234',
};
const glob = { id: 's1t1', boardId: 1 } as unknown as Glob;
const run = (
  pass: Pick<PostMergeKnowledgeService, 'run'>,
  e: Effect = effect,
  g: Glob | null = glob,
) => {
  const exec = postMergeKnowledgeExecutors(pass).post_merge_knowledge;
  if (exec === undefined) throw new Error('no executor');
  return exec(e, g, {} as never);
};

describe('postMergeKnowledgeExecutors', () => {
  it('runs the pass on the merge commit and returns its outcome', async () => {
    const pass = { run: vi.fn(() => Promise.resolve('done' as const)) };
    expect(await run(pass)).toBe('done');
    expect(pass.run).toHaveBeenCalledWith('s1t1', 'abc1234');
  });

  it('drops a job whose glob is gone', async () => {
    const pass = { run: vi.fn(() => Promise.resolve('done' as const)) };
    expect(await run(pass, effect, null)).toBe('dropped');
    expect(pass.run).not.toHaveBeenCalled();
  });

  it('waits without spending an attempt when the model is unusable, and rethrows other failures', async () => {
    const waiting = await run({
      run: () => Promise.reject(new LlmUnavailable('credentials expired', 'log in')),
    });
    expect(waiting).toMatchObject({ state: 'pending' });
    await expect(run({ run: () => Promise.reject(new Error('boom')) })).rejects.toThrow('boom');
  });
});

describe('HostSpecReader', () => {
  const files: Record<string, string> = {
    'docs/spec.md': 'SPEC',
    'docs/guide.md': 'GUIDE',
    'docs/other.txt': 'NO',
  };
  const host = {
    readFile: vi.fn((_r: unknown, _ref: string, path: string) =>
      Promise.resolve(files[path] ?? null),
    ),
    listFiles: vi.fn(() => Promise.resolve(['spec.md', 'guide.md', 'other.txt'])),
  };

  it('reads literal paths directly and expands a glob over the directory it starts in', async () => {
    const reader = new HostSpecReader(host);
    expect(await reader.read(board, 'sha', ['docs/spec.md'])).toEqual([
      { path: 'docs/spec.md', text: 'SPEC' },
    ]);
    const globbed = await reader.read(board, 'sha', ['docs/*.md']);
    expect(globbed.map((f) => f.path)).toEqual(['docs/spec.md', 'docs/guide.md']);
    expect(host.listFiles).toHaveBeenCalledWith(
      { owner: 'o', name: 'r', base: 'main' },
      'sha',
      'docs',
      expect.anything(),
    );
  });

  it('leaves out a file it cannot read and reads nothing for a board without a repo', async () => {
    const reader = new HostSpecReader(host);
    expect(await reader.read(board, 'sha', ['docs/missing.md'])).toEqual([]);
    expect(await reader.read({ ...board, repo: null }, 'sha', ['docs/spec.md'])).toEqual([]);
  });
});
