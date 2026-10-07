-- KB routing and dedupe: the pipeline's state, target, catalog flag, occurrence count, extra
-- evidence and links on each item, plus the draft columns step 3 fills. Existing open items start
-- pending, so the job routes the open backlog once; decided items count as routed. Idempotent.
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "processing" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "processing_error" text;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "processing_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "process_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "target" jsonb;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "catalog_candidate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "catalog_reason" text;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "occurrence_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "extra_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "duplicate_of" text;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "suppressed_by" text;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "covered_by" jsonb;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "contradicts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "draft" jsonb;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "drafted_against_version" integer;--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "rationale" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_proposals_processing_idx" ON "kb_proposals" USING btree ("processing","created_at");--> statement-breakpoint
UPDATE "kb_proposals" SET "processing" = 'routed' WHERE "status" <> 'open' AND "processing" = 'pending';
