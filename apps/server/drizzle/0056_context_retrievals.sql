CREATE TABLE "context_retrievals" (
	"board_id" integer NOT NULL,
	"day" date NOT NULL,
	"source_type" text NOT NULL,
	"tier" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "context_retrievals_board_id_day_source_type_tier_pk" PRIMARY KEY("board_id","day","source_type","tier")
);
--> statement-breakpoint
ALTER TABLE "context_retrievals" ADD CONSTRAINT "context_retrievals_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;