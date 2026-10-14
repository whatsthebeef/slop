CREATE TABLE "chat_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"email" text NOT NULL,
	"rating" text NOT NULL,
	"note" text,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"citations" jsonb,
	"tools" jsonb,
	"page" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_feedback" ADD CONSTRAINT "chat_feedback_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_feedback_message_idx" ON "chat_feedback" USING btree ("message_id","email");--> statement-breakpoint
CREATE INDEX "chat_feedback_board_idx" ON "chat_feedback" USING btree ("board_id","rating","created_at");