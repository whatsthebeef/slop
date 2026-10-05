CREATE TABLE "kb_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"status" text NOT NULL,
	"type" text NOT NULL,
	"statement" text NOT NULL,
	"evidence" text NOT NULL,
	"suggested_target" text,
	"source_glob_ids" jsonb NOT NULL,
	"source" text NOT NULL,
	"agent_set_version" integer,
	"submitted_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"version" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD CONSTRAINT "kb_proposals_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_proposals_board_status_idx" ON "kb_proposals" USING btree ("board_id","status");