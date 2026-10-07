-- Review findings: local reviews and CodeRabbit inline comments queued for splitting (review_sources),
-- and the classified findings split from them (review_findings). Existing local reviews are
-- backfilled as pending sources, so the findings pipeline splits them oldest first. Idempotent.
CREATE TABLE IF NOT EXISTS "review_sources" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"glob_id" text NOT NULL,
	"kind" text NOT NULL,
	"artifact_id" bigint,
	"external_id" text,
	"commit_sha" text,
	"agent_set_version" integer,
	"content" text,
	"path" text,
	"line" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"process_after" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "review_sources_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_findings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"glob_id" text NOT NULL,
	"source_id" bigint NOT NULL,
	"source" text NOT NULL,
	"commit_sha" text,
	"agent_set_version" integer,
	"severity" text NOT NULL,
	"round" integer,
	"path" text,
	"line" text,
	"text" text NOT NULL,
	"fingerprint" text NOT NULL,
	"class" text,
	"class_note" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"process_after" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"classified_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "review_findings_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "review_findings_source_id_review_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."review_sources"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_findings_fingerprint_idx" ON "review_findings" USING btree ("glob_id","source","fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_findings_queue_idx" ON "review_findings" USING btree ("state","process_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_findings_board_created_idx" ON "review_findings" USING btree ("board_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_findings_glob_idx" ON "review_findings" USING btree ("glob_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_sources_artifact_idx" ON "review_sources" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_sources_external_idx" ON "review_sources" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_sources_queue_idx" ON "review_sources" USING btree ("state","process_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_sources_glob_idx" ON "review_sources" USING btree ("glob_id");--> statement-breakpoint
INSERT INTO "review_sources" ("board_id", "glob_id", "kind", "artifact_id", "commit_sha", "agent_set_version", "created_at")
SELECT g."board_id", a."glob_id", 'local_review', a."id", a."commit_sha", (a."provenance"->>'agentSetVersion')::int, a."created_at"
FROM "artifacts" a JOIN "globs" g ON g."id" = a."glob_id"
WHERE a."kind" = 'local_review'
ON CONFLICT DO NOTHING;
