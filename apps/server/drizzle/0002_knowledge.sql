CREATE TABLE "artifacts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"glob_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"link" text,
	"commit_sha" text,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge" (
	"board_id" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"area" text,
	"audience" jsonb NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"version" integer NOT NULL,
	"source" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "knowledge_board_id_kind_name_pk" PRIMARY KEY("board_id","kind","name")
);
--> statement-breakpoint
CREATE TABLE "knowledge_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"area" text,
	"audience" jsonb NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "agent_set_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_version_idx" ON "artifacts" USING btree ("glob_id","kind","label","version");--> statement-breakpoint
CREATE INDEX "knowledge_history_doc_idx" ON "knowledge_history" USING btree ("board_id","kind","name","version");