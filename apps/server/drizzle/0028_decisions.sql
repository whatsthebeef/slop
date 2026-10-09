CREATE TABLE IF NOT EXISTS "decision_sources" (
	"board_id" integer NOT NULL,
	"source_ref" text NOT NULL,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"process_after" timestamp with time zone,
	"last_error" text,
	"glob_id" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"item_id" bigint NOT NULL,
	"glob_id" text,
	"glob_group" text,
	"statement" text NOT NULL,
	"quote" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_label" text NOT NULL,
	"source_url" text,
	"replaced_by" bigint,
	"replace_state" text,
	"replace_old_quote" text,
	"replace_new_quote" text,
	"replace_reason" text,
	"checked_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"process_after" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "decision_sources" ADD CONSTRAINT "decision_sources_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "decisions" ADD CONSTRAINT "decisions_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "decisions" ADD CONSTRAINT "decisions_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decision_sources_ref_idx" ON "decision_sources" USING btree ("board_id","source_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_sources_queue_idx" ON "decision_sources" USING btree ("state","process_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_sources_glob_idx" ON "decision_sources" USING btree ("glob_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decisions_item_idx" ON "decisions" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decisions_board_idx" ON "decisions" USING btree ("board_id","decided_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decisions_glob_idx" ON "decisions" USING btree ("glob_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decisions_source_idx" ON "decisions" USING btree ("board_id","source_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decisions_check_idx" ON "decisions" USING btree ("checked_at","process_after");