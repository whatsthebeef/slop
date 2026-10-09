import { describe, expect, it } from 'vitest';
import type { GlobView } from '../src/lib/api';
import { withGlob } from '../src/lib/glob-list';
import { glob } from '../../../packages/core/test/fixtures';

const view = (patch: Partial<GlobView> = {}): GlobView => ({ ...glob(), ...patch }) as GlobView;

describe('withGlob', () => {
  it('never adds a glob from another board', () => {
    const list = [view({ id: 's15t1', boardId: 15 })];
    expect(withGlob(list, view({ id: 's16t1', boardId: 16 }), 15)).toBe(list);
  });

  it('adds or replaces a glob of the same board, keeping known artifacts', () => {
    const artifacts = [{ kind: 'plan' }] as unknown as GlobView['artifacts'];
    const list = [view({ id: 's15t1', boardId: 15, version: 1, artifacts })];
    const next = withGlob(list, view({ id: 's15t1', boardId: 15, version: 2, artifacts: undefined }), 15);
    expect(next).toHaveLength(1);
    expect(next?.[0]).toMatchObject({ version: 2, artifacts });
  });

  it('leaves an unloaded list unloaded', () => {
    expect(withGlob(undefined, view({ boardId: 15 }), 15)).toBeUndefined();
  });
});
