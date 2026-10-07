-- A queued run that never calls slop is failed after this many minutes; the base branch's latest check result.
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "run_start_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "base_checks" jsonb;
