/** The viewer's remembered open/closed state of a collapsible section, or null when nothing usable is stored (or storage is unavailable). */
export const readSectionOpen = (key: string): boolean | null => {
  try {
    const v = window.localStorage.getItem(key);
    return v === 'open' ? true : v === 'closed' ? false : null;
  } catch {
    return null;
  }
};

export const writeSectionOpen = (key: string, open: boolean): void => {
  try {
    window.localStorage.setItem(key, open ? 'open' : 'closed');
  } catch {
    // Private mode or blocked storage: the choice just isn't remembered.
  }
};
