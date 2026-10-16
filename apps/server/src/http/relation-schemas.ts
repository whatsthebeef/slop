import { MAX_RELATION_REASON, MAX_RELATIONS, RELATION_GATES, RELATION_UNTILS, normaliseUntil } from '@slop/core';
import { z } from 'zod';

/** What `until` accepts: the stored values, and `rolled_out` as another way to write `merged` (merged and rolled out). */
export const RELATION_UNTIL_INPUTS = [...RELATION_UNTILS, 'rolled_out'] as const;

/**
 * A relation as REST and MCP receive it: this glob can't pass `gate` (default `start`) until `to` reaches `until` (default
 * `merged`, or `decided` when `to` is a decision glob). Core checks the rest (same board, not itself, no cycle, the limit).
 */
export const relationInputSchema = z
  .object({
    to: z.string().min(1),
    gate: z.enum(RELATION_GATES).optional(),
    until: z.enum(RELATION_UNTIL_INPUTS).optional(),
    reason: z.string().max(MAX_RELATION_REASON).nullable().optional(),
  })
  .strict();

/** A list of relations on create and update: at most the limit of one gate for each of the three gates. */
export const relationListSchema = z.array(relationInputSchema).max(MAX_RELATIONS * RELATION_GATES.length);

export type RelationBody = z.infer<typeof relationInputSchema>;

/** A relation in the shape core takes (a key left out stays out). */
export const relationInput = ({ to, gate, until, reason }: Pick<RelationBody, 'to' | 'gate' | 'until' | 'reason'>): { to: string; gate?: RelationBody['gate']; until?: (typeof RELATION_UNTILS)[number]; reason?: string | null } => ({
  to,
  ...(gate === undefined ? {} : { gate }),
  ...(until === undefined ? {} : { until: normaliseUntil(until) ?? 'merged' }),
  ...(reason === undefined ? {} : { reason }),
});

/** A glob a new glob holds back (`holds`, alias `follows_up`): a bare ID, or `{id, gate?, until?, reason?}`. */
export const holdInputSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1), gate: z.enum(RELATION_GATES).optional(), until: z.enum(RELATION_UNTIL_INPUTS).optional(), reason: z.string().max(MAX_RELATION_REASON).nullable().optional() }).strict(),
]);

/** A glob a glob supersedes: a bare ID, or `{id, reason?}`. */
export const supersedeInputSchema = z.union([z.string().min(1), z.object({ id: z.string().min(1), reason: z.string().max(MAX_RELATION_REASON).nullable().optional() }).strict()]);

export type HoldBody = z.infer<typeof holdInputSchema>;
export type SupersedeBody = z.infer<typeof supersedeInputSchema>;

/** `holds` in the shape core takes; a shared `reason` goes on every entry that has none. */
export const holdInputs = (list: readonly HoldBody[], reason?: string) =>
  list.map((h) => {
    const { id, gate, until, reason: own } = typeof h === 'string' ? { id: h } : h;
    const why = own ?? reason;
    return {
      id,
      ...(gate === undefined ? {} : { gate }),
      ...(until === undefined ? {} : { until: normaliseUntil(until) ?? 'merged' }),
      ...(why === undefined ? {} : { reason: why }),
    };
  });

/** `supersedes` in the shape core takes; a shared `reason` goes on every entry that has none. */
export const supersedeInputs = (list: readonly SupersedeBody[], reason?: string) =>
  list.map((s) => {
    const { id, reason: own } = typeof s === 'string' ? { id: s, reason: undefined } : s;
    const why = own ?? reason;
    return { id, ...(why === undefined ? {} : { reason: why }) };
  });

export const relationInputs = (list: readonly RelationBody[]) => list.map(relationInput);

/**
 * Adds one relation to the glob in the path: it is held back by `to` (needs the glob's version), holds `holdsBack` back (a
 * decision's "Holds back"; no version, the written glob is the other one) or supersedes `supersedes` (the row lands on that one).
 */
export const addRelationSchema = z
  .object({
    version: z.number().int().optional(),
    to: z.string().min(1).optional(),
    holdsBack: z.string().min(1).optional(),
    holdsBackGroup: z.string().min(1).optional(),
    /** This glob supersedes that one (the row lands on it; no version). */
    supersedes: z.string().min(1).optional(),
    gate: z.enum(RELATION_GATES).optional(),
    until: z.enum(RELATION_UNTIL_INPUTS).optional(),
    reason: z.string().max(MAX_RELATION_REASON).nullable().optional(),
  })
  .strict()
  .refine((b) => [b.to, b.holdsBack, b.holdsBackGroup, b.supersedes].filter((v) => v !== undefined).length === 1, {
    message: 'Give exactly one of `to` (the glob holds this one back), `holdsBack` (this glob holds that one back), `holdsBackGroup` (this glob holds every glob of that group back) or `supersedes` (this glob replaces that one)',
  })
  .refine((b) => b.to === undefined || b.version !== undefined, { message: '`version` is required when adding a relation to this glob' });
