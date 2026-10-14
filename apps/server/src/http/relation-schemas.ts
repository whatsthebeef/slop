import { MAX_RELATION_REASON, MAX_RELATIONS, RELATION_GATES, RELATION_UNTILS } from '@slop/core';
import { z } from 'zod';

/**
 * A relation as REST and MCP receive it: this glob can't pass `gate` (default `start`) until `to` reaches `until` (default
 * `merged`, or `decided` when `to` is a decision glob). Core checks the rest (same board, not itself, no cycle, the limit).
 */
export const relationInputSchema = z
  .object({
    to: z.string().min(1),
    gate: z.enum(RELATION_GATES).optional(),
    until: z.enum(RELATION_UNTILS).optional(),
    reason: z.string().max(MAX_RELATION_REASON).nullable().optional(),
  })
  .strict();

/** A list of relations on create and update: at most the limit of one gate for each of the three gates. */
export const relationListSchema = z.array(relationInputSchema).max(MAX_RELATIONS * RELATION_GATES.length);

export type RelationBody = z.infer<typeof relationInputSchema>;

/** A relation in the shape core takes (a key left out stays out). */
export const relationInput = ({ to, gate, until, reason }: RelationBody): { to: string; gate?: RelationBody['gate']; until?: RelationBody['until']; reason?: string | null } => ({
  to,
  ...(gate === undefined ? {} : { gate }),
  ...(until === undefined ? {} : { until }),
  ...(reason === undefined ? {} : { reason }),
});

export const relationInputs = (list: readonly RelationBody[]) => list.map(relationInput);

/**
 * Adds one relation to the glob in the path: it is held back by `to` (needs the glob's version), or holds `holdsBack` back (a
 * decision's "Holds back"; no version, the written glob is the other one).
 */
export const addRelationSchema = z
  .object({
    version: z.number().int().optional(),
    to: z.string().min(1).optional(),
    holdsBack: z.string().min(1).optional(),
    holdsBackGroup: z.string().min(1).optional(),
    gate: z.enum(RELATION_GATES).optional(),
    until: z.enum(RELATION_UNTILS).optional(),
    reason: z.string().max(MAX_RELATION_REASON).nullable().optional(),
  })
  .strict()
  .refine((b) => [b.to, b.holdsBack, b.holdsBackGroup].filter((v) => v !== undefined).length === 1, {
    message: 'Give exactly one of `to` (the glob holds this one back), `holdsBack` (this glob holds that one back) or `holdsBackGroup` (this glob holds every glob of that group back)',
  })
  .refine((b) => b.to === undefined || b.version !== undefined, { message: '`version` is required when adding a relation to this glob' });
