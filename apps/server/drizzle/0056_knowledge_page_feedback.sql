CREATE TABLE "knowledge_page_feedback" (
	"board_id" integer NOT NULL,
	"glob_id" text NOT NULL,
	"verdict" text NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "knowledge_page_feedback_board_id_glob_id_pk" PRIMARY KEY("board_id","glob_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_page_feedback" ADD CONSTRAINT "knowledge_page_feedback_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;