CREATE TABLE "board_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" integer,
	"source" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"link" text,
	"action" jsonb,
	"since" timestamp with time zone NOT NULL,
	"clears" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_notifications" ADD CONSTRAINT "board_notifications_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_notifications_board_idx" ON "board_notifications" USING btree ("board_id");