CREATE TABLE "glob_size_checks" (
	"glob_id" text PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"plan_hash" text NOT NULL,
	"estimate" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"threshold" jsonb NOT NULL,
	"flagged" boolean NOT NULL,
	"reasons" jsonb NOT NULL,
	"proposal" jsonb,
	"decision" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "size_threshold_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"from_tasks" integer NOT NULL,
	"to_tasks" integer NOT NULL,
	"from_parts" integer NOT NULL,
	"to_parts" integer NOT NULL,
	"outcome" text NOT NULL,
	"glob_id" text NOT NULL,
	"evidence" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "size_thresholds" (
	"board_id" integer PRIMARY KEY NOT NULL,
	"max_tasks" integer NOT NULL,
	"max_parts" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "glob_size_checks" ADD CONSTRAINT "glob_size_checks_glob_id_globs_id_fk" FOREIGN KEY ("glob_id") REFERENCES "public"."globs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glob_size_checks" ADD CONSTRAINT "glob_size_checks_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "size_threshold_changes" ADD CONSTRAINT "size_threshold_changes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "size_thresholds" ADD CONSTRAINT "size_thresholds_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "glob_size_checks_board_idx" ON "glob_size_checks" USING btree ("board_id");--> statement-breakpoint
CREATE UNIQUE INDEX "size_threshold_changes_glob_idx" ON "size_threshold_changes" USING btree ("board_id","glob_id");