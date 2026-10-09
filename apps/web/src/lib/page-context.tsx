import { createContext, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';

/** Where the person is, as the chat sees it: the page type, the item it shows and (for a glob) its state. */
export interface PageContext {
  readonly type: 'board' | 'glob' | 'knowledge' | 'inbox' | 'signed_off' | 'settings';
  /** The glob, knowledge item or inbox item the page shows. */
  readonly id?: string;
  /** For a glob: failed or merged change which questions are suggested. */
  readonly state?: 'failed' | 'merged' | 'open';
}

export const BOARD_PAGE: PageContext = { type: 'board' };

const PageContextValue = createContext<{ page: PageContext; setPage: (page: PageContext) => void }>({ page: BOARD_PAGE, setPage: () => undefined });

/** Held by the board shell, which outlives the pages, so the chat reads the current page while keeping its own state. */
export const PageContextProvider = ({ page, setPage, children }: { page: PageContext; setPage: (page: PageContext) => void; children: ReactNode }) => (
  <PageContextValue.Provider value={{ page, setPage }}>{children}</PageContextValue.Provider>
);

export const useCurrentPage = (): PageContext => useContext(PageContextValue).page;

/** A page declares what it shows: `usePageContext({ type: 'glob', id: 's15f25' })`. The chat's scope chip follows it. */
export const usePageContext = (page: PageContext): void => {
  const { setPage } = useContext(PageContextValue);
  const { type, id, state } = page;
  useEffect(() => {
    setPage({ type, ...(id === undefined ? {} : { id }), ...(state === undefined ? {} : { state }) });
    return () => setPage(BOARD_PAGE);
  }, [setPage, type, id, state]);
};
