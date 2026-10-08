-- Slice 7, part 2: release and integration deploys and which globs each environment holds (environment_deploys,
-- glob_environments), ATF runs (test_runs), and CodeRabbit's reviews stored verbatim (code_review_comments). Idempotent.
CREATE TABLE IF NOT EXISTS "code_review_comments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"glob_id" text NOT NULL,
	"pr_number" integer NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"author" text NOT NULL,
	"commit_sha" text,
	"path" text,
	"line" text,
	"body" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "code_review_comments_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- An earlier draft of this migration created the table without its tombstone column.
ALTER TABLE "code_review_comments" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "environment_deploys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"environment" text NOT NULL,
	"sha" text NOT NULL,
	"ref" text,
	"succeeded" boolean NOT NULL,
	"url" text,
	"event_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "environment_deploys_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "glob_environments" (
	"board_id" integer NOT NULL,
	"glob_id" text NOT NULL,
	"environment" text NOT NULL,
	"merge_sha" text NOT NULL,
	"contained" boolean NOT NULL,
	"checked_sha" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"since" timestamp with time zone,
	CONSTRAINT "glob_environments_glob_id_environment_pk" PRIMARY KEY("glob_id","environment"),
	CONSTRAINT "glob_environments_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"kind" text NOT NULL,
	"glob_id" text,
	"environment" text,
	"sha" text NOT NULL,
	"passed" integer NOT NULL,
	"failed" integer NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"url" text,
	"event_id" text NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "test_runs_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "code_review_comments_external_idx" ON "code_review_comments" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_review_comments_glob_idx" ON "code_review_comments" USING btree ("glob_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_review_comments_board_glob_idx" ON "code_review_comments" USING btree ("board_id","glob_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environment_deploys_event_idx" ON "environment_deploys" USING btree ("board_id","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_deploys_board_env_at_idx" ON "environment_deploys" USING btree ("board_id","environment","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "glob_environments_board_env_idx" ON "glob_environments" USING btree ("board_id","environment","contained");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "test_runs_event_idx" ON "test_runs" USING btree ("board_id","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_board_env_sha_idx" ON "test_runs" USING btree ("board_id","environment","sha");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_glob_idx" ON "test_runs" USING btree ("glob_id");