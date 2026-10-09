CREATE TABLE "inbox_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"text" text NOT NULL,
	"source" text DEFAULT 'paste' NOT NULL,
	"source_label" text DEFAULT '' NOT NULL,
	"source_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"summary" text,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"process_after" timestamp with time zone,
	"last_error" text,
	"item_id" bigint,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_links" (
	"inbox_id" bigint NOT NULL,
	"glob_id" text NOT NULL,
	"artifact_id" bigint,
	"linked_by" text,
	"linked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inbox_links_inbox_id_glob_id_pk" PRIMARY KEY("inbox_id","glob_id")
);
--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_links" ADD CONSTRAINT "inbox_links_inbox_id_inbox_items_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_items_hash_idx" ON "inbox_items" USING btree ("board_id","content_hash");--> statement-breakpoint
CREATE INDEX "inbox_items_board_idx" ON "inbox_items" USING btree ("board_id","status","occurred_at");--> statement-breakpoint
CREATE INDEX "inbox_items_queue_idx" ON "inbox_items" USING btree ("state","process_after");--> statement-breakpoint
CREATE INDEX "inbox_links_glob_idx" ON "inbox_links" USING btree ("glob_id");