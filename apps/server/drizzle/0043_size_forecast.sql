CREATE TABLE IF NOT EXISTS "glob_size_records" (
	"glob_id" text PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"estimate" jsonb NOT NULL,
	"investigation" jsonb,
	"actual" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "size_calibration_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"glob_id" text NOT NULL,
	"kind" text NOT NULL,
	"area" text,
	"from" jsonb NOT NULL,
	"to" jsonb NOT NULL,
	"cause" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "size_calibrations" (
	"board_id" integer PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "glob_size_records" ADD CONSTRAINT "glob_size_records_glob_id_globs_id_fk" FOREIGN KEY ("glob_id") REFERENCES "public"."globs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "glob_size_records" ADD CONSTRAINT "glob_size_records_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "size_calibration_changes" ADD CONSTRAINT "size_calibration_changes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "size_calibrations" ADD CONSTRAINT "size_calibrations_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "glob_size_records_board_idx" ON "glob_size_records" USING btree ("board_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "size_calibration_changes_outcome_idx" ON "size_calibration_changes" USING btree ("board_id","glob_id","cause");
