-- Weekly consolidation: a stale flag on open KB items (never a closure) and when an admin last kept one, the items an
-- admin kept apart by reopening a merge, the verified quotes of a consolidation merge, and what a board job keeps
-- between runs (consolidation's checked pairs). Idempotent.
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "stale_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "stale_reason" text;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "stale_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "kept_apart_from" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "merge_note" jsonb;--> statement-breakpoint
ALTER TABLE "board_jobs" ADD COLUMN IF NOT EXISTS "state" jsonb;
