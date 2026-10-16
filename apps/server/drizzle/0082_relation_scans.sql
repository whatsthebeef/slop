CREATE TABLE IF NOT EXISTS "relation_scans" (
	"glob_id" text NOT NULL,
	"mentioned_id" text NOT NULL,
	"sentence_hash" text NOT NULL,
	"board_id" integer NOT NULL,
	"kind" text NOT NULL,
	"decision" text NOT NULL,
	"gate" text,
	"reason" text,
	"sentence" text NOT NULL,
	"relation_id" text,
	"state" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "relation_scans_glob_id_mentioned_id_sentence_hash_pk" PRIMARY KEY("glob_id","mentioned_id","sentence_hash"),
	CONSTRAINT "relation_scans_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relation_scans_board_state_idx" ON "relation_scans" USING btree ("board_id","state");
