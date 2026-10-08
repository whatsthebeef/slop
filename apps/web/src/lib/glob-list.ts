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
