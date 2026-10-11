CREATE TABLE "code_files" (
	"board_id" integer NOT NULL,
	"path" text NOT NULL,
	"size" integer NOT NULL,
	"language" text,
	CONSTRAINT "code_files_board_id_path_pk" PRIMARY KEY("board_id","path")
);
--> statement-breakpoint
CREATE TABLE "code_imports" (
	"board_id" integer NOT NULL,
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	CONSTRAINT "code_imports_board_id_from_path_to_path_pk" PRIMARY KEY("board_id","from_path","to_path")
);
--> statement-breakpoint
CREATE TABLE "code_index" (
	"board_id" integer PRIMARY KEY NOT NULL,
	"commit_sha" text NOT NULL,
	"file_count" integer NOT NULL,
	"indexed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_path_commits" (
	"board_id" integer NOT NULL,
	"path" text NOT NULL,
	"sha" text NOT NULL,
	"subject" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"seq" integer NOT NULL,
	"glob_id" text,
	CONSTRAINT "code_path_commits_board_id_path_sha_pk" PRIMARY KEY("board_id","path","sha")
);
--> statement-breakpoint
CREATE TABLE "code_view_usage" (
	"board_id" integer NOT NULL,
	"consumer" text NOT NULL,
	"op" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"empty_results" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	CONSTRAINT "code_view_usage_board_id_consumer_op_pk" PRIMARY KEY("board_id","consumer","op")
);
--> statement-breakpoint
ALTER TABLE "code_files" ADD CONSTRAINT "code_files_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_imports" ADD CONSTRAINT "code_imports_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index" ADD CONSTRAINT "code_index_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_path_commits" ADD CONSTRAINT "code_path_commits_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_view_usage" ADD CONSTRAINT "code_view_usage_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_imports_to_idx" ON "code_imports" USING btree ("board_id","to_path");--> statement-breakpoint
CREATE INDEX "code_path_commits_path_idx" ON "code_path_commits" USING btree ("board_id","path","seq");