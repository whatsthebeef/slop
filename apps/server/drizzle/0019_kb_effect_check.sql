-- Effect checks: how many globs each side of an approved change is compared over (a board setting, 3 to 50), and each
-- approved item's check (its basis, before and after figures, verdict and raised item). Idempotent.
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "effect_check_globs" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "effect_check" jsonb;
