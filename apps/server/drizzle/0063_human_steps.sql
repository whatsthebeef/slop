CREATE TABLE IF NOT EXISTS "human_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"glob_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"who" text NOT NULL,
	"due" text NOT NULL,
	"state" text NOT NULL,
	"blocks" jsonb NOT NULL,
	"check" text,
	"script" jsonb,
	"origin" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"done_by" text,
	"done_at" timestamp with time zone,
	"dismissed_reason" text
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "human_steps" ADD CONSTRAINT "human_steps_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "human_steps_glob_idx" ON "human_steps" USING btree ("glob_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "human_steps_board_idx" ON "human_steps" USING btree ("board_id","state");