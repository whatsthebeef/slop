CREATE TABLE IF NOT EXISTS "board_chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "board_chat_messages" ADD CONSTRAINT "board_chat_messages_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_chat_messages_person_idx" ON "board_chat_messages" USING btree ("board_id","email","id");
