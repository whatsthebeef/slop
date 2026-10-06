-- Layered agent set: a board's agent-set row is now its overlay on a catalog file or a whole file it
-- owns. Rows still marked as catalog copies were never edited, so they become empty overlays and
-- the board serves the current catalog file; rows with any other source stay whole files (legacy
-- overrides the Knowledge page flags). agent_catalog_hash starts null, so the first start after
-- this bumps every board's agent-set version once. Idempotent.
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "agent_catalog_hash" text;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN IF NOT EXISTS "layer" text DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_history" ADD COLUMN IF NOT EXISTS "layer" text DEFAULT 'file' NOT NULL;--> statement-breakpoint
UPDATE "knowledge" SET "layer" = 'overlay', "content" = '' WHERE "kind" <> 'doc' AND "source" = 'catalog:agents' AND "layer" = 'file';
