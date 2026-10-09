CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" bigint NOT NULL,
	"board_id" integer NOT NULL,
	"position" integer NOT NULL,
	"header" text NOT NULL,
	"text" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', header || ' ' || text)) STORED,
	"embedding" vector(1024),
	"embedded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"source_type" text NOT NULL,
	"external_ref" text NOT NULL,
	"title" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authority" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by" bigint,
	"glob_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"glob_group" text,
	"external_url" text,
	"body" text,
	"body_key" text,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"process_after" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "chunks" ADD CONSTRAINT "chunks_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chunks_item_position_idx" ON "chunks" USING btree ("item_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_board_idx" ON "chunks" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_tsv_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_text_trgm_idx" ON "chunks" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_unembedded_idx" ON "chunks" USING btree ("id") WHERE "chunks"."embedding" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_items_ref_idx" ON "knowledge_items" USING btree ("board_id","external_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_board_source_idx" ON "knowledge_items" USING btree ("board_id","source_type","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_globs_idx" ON "knowledge_items" USING gin ("glob_ids");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_pending_idx" ON "knowledge_items" USING btree ("state","process_after");