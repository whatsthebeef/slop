CREATE TABLE IF NOT EXISTS "knowledge_page_versions" (
	"board_id" integer NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"sections" jsonb NOT NULL,
	"changed" jsonb NOT NULL,
	"basis" jsonb NOT NULL,
	CONSTRAINT "knowledge_page_versions_board_id_version_pk" PRIMARY KEY("board_id","version")
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "knowledge_page_interval_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_page_versions" ADD CONSTRAINT "knowledge_page_versions_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
