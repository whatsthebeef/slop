DROP INDEX IF EXISTS "outbox_pending_idx";--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN IF NOT EXISTS "lane" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_lane_pending_idx" ON "outbox" USING btree ("lane","state","run_after");
