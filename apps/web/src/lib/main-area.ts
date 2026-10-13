/**
 * The board shell's scroll container: the only element that scrolls a page (the board, a glob view). It is `relative` so
 * it is the containing block of every absolutely positioned descendant, such as a Tip's `sr-only` description. Without
 * it those resolve against <body>, sit at their place in the content and make the document taller than the `h-dvh`
 * shell: the window then scrolls too, the shell slides up and blank page shows below content cut at a hard edge (s15b87).
 */
export const MAIN_AREA_CLASS = 'relative min-h-0 min-w-0 flex-1 overflow-auto';
