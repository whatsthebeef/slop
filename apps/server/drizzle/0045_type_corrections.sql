CREATE TABLE IF NOT EXISTS "type_corrections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"glob_id" text NOT NULL,
	"from_type" text NOT NULL,
	"to_type" text NOT NULL,
	"actor" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"signals" jsonb NOT NULL,
	"reset_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "type_corrections" ADD CONSTRAINT "type_corrections_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "type_corrections_board_idx" ON "type_corrections" USING btree ("board_id","at");
