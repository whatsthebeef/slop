ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "decision_glob_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_proposals_decision_glob_idx" ON "kb_proposals" USING btree ("decision_glob_id");
