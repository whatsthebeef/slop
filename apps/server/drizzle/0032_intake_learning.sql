CREATE TABLE "glob_outcomes" (
	"glob_id" text PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"snapshot_version" integer NOT NULL,
	"outcome" jsonb NOT NULL,
	"final" boolean NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_snapshots" (
	"glob_id" text NOT NULL,
	"version" integer NOT NULL,
	"board_id" integer NOT NULL,
	"request" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"plan" text NOT NULL,
	"creator" text NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"group_name" text,
	"environment" text,
	"category_confidence" text,
	"reason" text,
	"model" text,
	"prompt_version" integer,
	"features" jsonb NOT NULL,
	"examples" jsonb NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "intake_snapshots_glob_id_version_pk" PRIMARY KEY("glob_id","version")
);
--> statement-breakpoint
ALTER TABLE "glob_outcomes" ADD CONSTRAINT "glob_outcomes_glob_id_globs_id_fk" FOREIGN KEY ("glob_id") REFERENCES "public"."globs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glob_outcomes" ADD CONSTRAINT "glob_outcomes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_snapshots" ADD CONSTRAINT "intake_snapshots_glob_id_globs_id_fk" FOREIGN KEY ("glob_id") REFERENCES "public"."globs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_snapshots" ADD CONSTRAINT "intake_snapshots_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "glob_outcomes_board_idx" ON "glob_outcomes" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "intake_snapshots_board_idx" ON "intake_snapshots" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "intake_snapshots_embedding_idx" ON "intake_snapshots" USING hnsw ("embedding" vector_cosine_ops);