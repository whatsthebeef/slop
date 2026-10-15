CREATE TABLE "atf_runners" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"name" text NOT NULL,
	"method" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"environments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_result_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "runner_id" bigint;--> statement-breakpoint
ALTER TABLE "atf_runners" ADD CONSTRAINT "atf_runners_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "atf_runners_name_idx" ON "atf_runners" USING btree ("board_id",lower("name")) WHERE "atf_runners"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_runner_id_atf_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."atf_runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_runs_runner_idx" ON "test_runs" USING btree ("runner_id");