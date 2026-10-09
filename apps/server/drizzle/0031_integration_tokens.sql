CREATE TABLE "integration_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "inbox_items" ADD COLUMN "source_ref" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_tokens_hash_idx" ON "integration_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_tokens_active_idx" ON "integration_tokens" USING btree ("board_id") WHERE "integration_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_items_source_ref_idx" ON "inbox_items" USING btree ("board_id","source","source_ref") WHERE "inbox_items"."source_ref" <> '';