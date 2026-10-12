CREATE TABLE "context_setting_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"key" text NOT NULL,
	"before" double precision NOT NULL,
	"after" double precision NOT NULL,
	"outcome" text NOT NULL,
	"evidence" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_settings" (
	"board_id" integer NOT NULL,
	"key" text NOT NULL,
	"value" double precision NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "context_settings_board_id_key_pk" PRIMARY KEY("board_id","key")
);
--> statement-breakpoint
ALTER TABLE "context_setting_changes" ADD CONSTRAINT "context_setting_changes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_settings" ADD CONSTRAINT "context_settings_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_setting_changes_board_at_idx" ON "context_setting_changes" USING btree ("board_id","at");