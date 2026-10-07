-- The learned sub size limit's history (boards.sub_max_changed_lines is the learned value, default 2000): each sub
-- outcome recorded once per board, glob and outcome, with the limit before and after it. Idempotent.
CREATE TABLE IF NOT EXISTS "sub_limit_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"from_lines" integer NOT NULL,
	"to_lines" integer NOT NULL,
	"outcome" text NOT NULL,
	"glob_id" text NOT NULL,
	"changed_lines" integer,
	"evidence" text NOT NULL,
	CONSTRAINT "sub_limit_changes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sub_limit_changes_outcome_idx" ON "sub_limit_changes" USING btree ("board_id","glob_id","outcome");
