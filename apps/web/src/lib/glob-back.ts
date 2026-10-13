/** What Esc needs to know about the page to decide whether it goes back to the board. */
export interface EscapeTarget {
  tag: string;
  editable: boolean;
}

/** Selector for popovers, menus, dropdowns and dialogs: Esc closes those first. */
export const OPEN_OVERLAY = '[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"]';

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Esc goes back unless something else owns it: typing, an open overlay, an inline confirmation, or a handler that took it. */
export const escapeGoesBack = (key: string, defaultPrevented: boolean, target: EscapeTarget, overlayOpen: boolean, confirming: boolean): boolean =>
  key === 'Escape' && !defaultPrevented && !TYPING.has(target.tag.toUpperCase()) && !target.editable && !overlayOpen && !confirming;
