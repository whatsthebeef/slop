import { CAPABILITY_NAMES, CAPABILITY_TEXT } from '@slop/core';
import type { Capabilities, CapabilityName } from '@slop/core';

export interface CapabilityRow {
  readonly name: CapabilityName;
  readonly text: string;
  /** On, off, or unknown (the server doesn't report it: an older API, or no switch for it). */
  readonly state: 'on' | 'off' | 'unknown';
}

/** The System list: every capability slop knows, in its order, with what the server said about it. */
export const capabilityRows = (capabilities: Capabilities | undefined): CapabilityRow[] =>
  CAPABILITY_NAMES.map((name) => {
    const on = capabilities?.[name];
    return { name, text: CAPABILITY_TEXT[name], state: on === undefined ? 'unknown' : on ? 'on' : 'off' };
  });
