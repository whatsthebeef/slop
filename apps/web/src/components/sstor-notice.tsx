import type { Action } from '@slop/core';
import { useToast } from '@/toast';
import { copyOrSelect } from '@/lib/plan-text';
import { copySstorCommand } from '@/lib/sstor-command';

/** The notice after Pick up: says the command was copied, or shows it to copy by hand when the clipboard refused. */
const Notice = ({ globId, command, copied }: { globId: string; command: string; copied: boolean }) =>
  copied ? (
    <span>
      Picked up {globId} · Copied <code>{command}</code>
    </span>
  ) : (
    <span className='grid gap-1'>
      <span>Picked up {globId} · Couldn't copy, so copy it by hand:</span>
      <span className='flex items-center gap-2'>
        <code className='select-all rounded bg-muted px-1 py-0.5'>{command}</code>
        <button
          type='button'
          className='rounded border px-1.5 py-0.5 text-xs hover:bg-muted'
          onClick={() => void copyOrSelect(command, typeof navigator === 'undefined' ? undefined : navigator.clipboard, () => undefined)}
        >
          Copy
        </button>
      </span>
    </span>
  );

/**
 * Copies the sstor command for Pick up. `begin` runs synchronously in the click handler, before the request;
 * the returned `finish` shows the notice once the request succeeded.
 */
export const useSstorCopy = () => {
  const toast = useToast();
  return (action: Action, globId: string): (() => Promise<void>) => {
    const copy = copySstorCommand(action, globId, typeof navigator === 'undefined' ? undefined : navigator.clipboard);
    return async () => {
      const result = await copy;
      if (result !== null) toast(<Notice globId={globId} command={result.command} copied={result.copied} />, result.copied ? 5000 : 20000);
    };
  };
};
