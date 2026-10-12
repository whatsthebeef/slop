import type { Action } from '@slop/core';
import { copyOrSelect } from '@/lib/plan-text';

/** The sstor command that starts the person's own session after Pick up or Take over; null for any other action. */
export const sstorCommand = (action: Action, globId: string): string | null => {
  if (action === 'pick_up') return `sstor --glob ${globId}`;
  if (action === 'take_over') return `sstor --glob ${globId} --take-over`;
  return null;
};

/**
 * Starts copying the action's sstor command. Call it synchronously in the click handler, before awaiting the request:
 * browsers refuse clipboard writes once the user gesture has passed. Resolves to the command and whether it was copied,
 * or null when the action has no command.
 */
export const copySstorCommand = (
  action: Action,
  globId: string,
  clipboard: { writeText: (text: string) => Promise<void> } | undefined,
): Promise<{ command: string; copied: boolean }> | null => {
  const command = sstorCommand(action, globId);
  if (command === null) return null;
  return copyOrSelect(command, clipboard, () => undefined).then((copied) => ({ command, copied }));
};
