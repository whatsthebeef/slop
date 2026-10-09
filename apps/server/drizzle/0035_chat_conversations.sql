CREATE TABLE IF NOT EXISTS "board_chats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"email" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "board_chat_messages_person_idx";--> statement-breakpoint
ALTER TABLE "board_chat_messages" ADD COLUMN IF NOT EXISTS "chat_id" bigint;--> statement-breakpoint
ALTER TABLE "board_chat_messages" ADD COLUMN IF NOT EXISTS "tools" jsonb;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "board_chats" ADD CONSTRAINT "board_chats_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- Each person's one conversation per board becomes their first conversation, titled by its first question.
INSERT INTO "board_chats" ("board_id", "email", "title", "created_at", "updated_at")
SELECT m."board_id", m."email",
	COALESCE((SELECT left(u."content", 80) FROM "board_chat_messages" u WHERE u."board_id" = m."board_id" AND u."email" = m."email" AND u."role" = 'user' ORDER BY u."id" LIMIT 1), 'Earlier conversation'),
	min(m."created_at"), max(m."created_at")
FROM "board_chat_messages" m
WHERE m."chat_id" IS NULL
GROUP BY m."board_id", m."email";--> statement-breakpoint
UPDATE "board_chat_messages" m SET "chat_id" = c."id"
FROM "board_chats" c
WHERE m."chat_id" IS NULL AND c."board_id" = m."board_id" AND c."email" = m."email";--> statement-breakpoint
ALTER TABLE "board_chat_messages" ALTER COLUMN "chat_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_chats_person_idx" ON "board_chats" USING btree ("board_id","email","updated_at");--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "board_chat_messages" ADD CONSTRAINT "board_chat_messages_chat_id_board_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."board_chats"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_chat_messages_chat_idx" ON "board_chat_messages" USING btree ("chat_id","id");
