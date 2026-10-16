CREATE TABLE IF NOT EXISTS "relation_learning" (
	"board_id" integer PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	CONSTRAINT "relation_learning_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relation_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"from_glob" text NOT NULL,
	"to_glob" text NOT NULL,
	"relation_id" text,
	"source" text NOT NULL,
	"signal" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"evidence" text NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "relation_signals_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "verdict" text;--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "verdict_reason" text;--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "verdict_by" text;--> statement-breakpoint
ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "verdict_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relation_signals_board_key_idx" ON "relation_signals" USING btree ("board_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relation_signals_board_at_idx" ON "relation_signals" USING btree ("board_id","at");
