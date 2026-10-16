import { useCallback, useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
/** How long a button that asks for a second click stays armed before it reverts. */
export const CONFIRM_MS = 4000;

/**
 * A button that asks for a second click: the first only arms it, a second within `CONFIRM_MS` runs it, and the timeout,
 * Escape or blur reverts it. Shared by the Merge chip and the card's Fix conflict button so they behave the same.
 */
export const useConfirmClick = () => {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  const cancel = useCallback(() => setConfirming(false), []);
  /** Handles a click: true when the action should run now, false when the click only armed the button. */
  const click = (needsConfirm: boolean): boolean => {
    if (needsConfirm && !confirming) {
      setConfirming(true);
      return false;
    }
    setConfirming(false);
    return true;
  };
  /** Keys from the button are its own (Escape reverts); they never reach the card. */
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') setConfirming(false);
  };
  return { confirming, click, cancel, onKeyDown };
};
