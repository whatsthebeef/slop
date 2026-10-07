-- A KB item the dedupe step thinks the target's own text may already say stays open with this flag
-- (target, section, verified quote, reason) instead of being closed as covered. Idempotent.
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "possibly_covered_by" jsonb;
