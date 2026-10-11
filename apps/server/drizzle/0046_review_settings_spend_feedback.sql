CREATE TABLE IF NOT EXISTS "llm_spend" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"glob_id" text,
	"source" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" double precision,
	"ref" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"glob_id" text NOT NULL,
	"artifact_version" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"path" text NOT NULL,
	"line" integer,
	"verdict" text NOT NULL,
	"source" text NOT NULL,
	"github_comment_id" bigint NOT NULL,
	"actor" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "review_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "llm_spend" ADD CONSTRAINT "llm_spend_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "review_feedback" ADD CONSTRAINT "review_feedback_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_spend_board_created_idx" ON "llm_spend" USING btree ("board_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_feedback_comment_idx" ON "review_feedback" USING btree ("github_comment_id","source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_feedback_board_created_idx" ON "review_feedback" USING btree ("board_id","created_at");