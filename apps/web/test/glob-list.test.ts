import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { GlobView } from '../src/lib/api';
import { putGlob, withGlob } from '../src/lib/glob-list';
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

describe('putGlob', () => {
  it('keeps a glob that arrives while an older list fetch is in flight', async () => {
    const client = new QueryClient();
    const key = ['globs', 15] as const;
    const server: GlobView[] = [];
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const queryFn = async (): Promise<GlobView[]> => {
      calls += 1;
      const snapshot = [...server];
      if (calls === 1) await slow;
      return snapshot;
    };
    client.setQueryData<GlobView[]>(key, []);
    const loading = client.query({ queryKey: key, queryFn, staleTime: 0 });
    // The glob is created after that fetch read the list, and its hint arrives before the fetch lands.
    const created = view({ id: 's15f60', boardId: 15 });
    server.push(created);
    putGlob(client, key, created, 15);
    release();
    await loading.catch(() => undefined);
    await vi.waitFor(() => expect(client.getQueryData<GlobView[]>(key)?.map((g) => g.id)).toEqual(['s15f60']));
  });
});
