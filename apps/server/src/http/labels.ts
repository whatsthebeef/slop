import { machine } from '@slop/core';
import type { LabelCommand } from '@slop/core';
import { z } from 'zod';

/** A sign-off label command as REST and MCP receive it (`kind` picks the action). */
export const labelCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('submit_items'),
    items: z
      .array(z.string().max(machine.MAX_CHECKLIST_ITEM_LENGTH))
      .min(1)
      .max(machine.MAX_CHECKLIST_ITEMS),
  }),
  z.object({ kind: z.literal('approve') }),
  z.object({ kind: z.literal('tick'), itemId: z.string().min(1), done: z.boolean() }),
  z.object({ kind: z.literal('resubmit') }),
  z.object({ kind: z.literal('reopen') }),
]);

export const LABEL_COMMAND_KINDS = [
  'submit_items',
  'approve',
  'tick',
  'resubmit',
  'reopen',
] as const satisfies readonly LabelCommand['kind'][];

/** Reads a command from flat input (MCP tools take a flat shape); null when it is incomplete. */
export const parseLabelCommand = (input: unknown): LabelCommand | null => {
  const parsed = labelCommandSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
};
