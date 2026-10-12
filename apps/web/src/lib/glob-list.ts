import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { GlobView } from './api';

/**
 * The board's list with `glob` put in (replacing its older copy). A glob from another board is
 * never added, and a list that isn't loaded yet stays unloaded.
 */
export const withGlob = (list: GlobView[] | undefined, glob: GlobView, boardId: number): GlobView[] | undefined => {
  if (list === undefined || glob.boardId !== boardId) return list;
  const artifacts = glob.artifacts ?? list.find((g) => g.id === glob.id)?.artifacts;
  return [...list.filter((g) => g.id !== glob.id), artifacts === undefined ? glob : { ...glob, artifacts }];
};

/**
 * Puts `glob` into the cached board list. A list fetch already in flight started before the glob existed (or changed)
 * and would overwrite it with its older answer when it lands, so the glob would stay off the board until a refresh:
 * the fetch is restarted to read the list again.
 */
export const putGlob = (client: QueryClient, key: QueryKey, glob: GlobView, boardId: number): void => {
  client.setQueryData<GlobView[]>(key, (list) => withGlob(list, glob, boardId));
  if (client.isFetching({ queryKey: key }) > 0) void client.refetchQueries({ queryKey: key });
};
