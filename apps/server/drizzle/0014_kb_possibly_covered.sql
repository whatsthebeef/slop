-- KB dedupe: an open item the routed target's text may already cover is flagged, not closed.
-- Idempotent.
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "possibly_covered_by" jsonb;
