CREATE TABLE IF NOT EXISTS "board_sessions" (
	"email" text NOT NULL,
	"board_id" integer NOT NULL,
	"position" integer,
	"last_viewed_at" timestamp with time zone,
	CONSTRAINT "board_sessions_email_board_id_pk" PRIMARY KEY("email","board_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "board_sessions" ADD CONSTRAINT "board_sessions_board_id_email_members_board_id_email_fk" FOREIGN KEY ("board_id","email") REFERENCES "public"."members"("board_id","email") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "board_sessions_position_idx" ON "board_sessions" USING btree ("email","position") WHERE "board_sessions"."position" is not null;
