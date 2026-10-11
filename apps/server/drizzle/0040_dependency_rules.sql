CREATE TABLE "dependency_rule_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"pattern" text NOT NULL,
	"from_weight" double precision NOT NULL,
	"to_weight" double precision NOT NULL,
	"cause" text NOT NULL,
	"glob_id" text,
	"evidence" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dependency_rules" (
	"board_id" integer NOT NULL,
	"pattern" text NOT NULL,
	"weight" double precision NOT NULL,
	"clean_count" integer DEFAULT 0 NOT NULL,
	"conflict_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dependency_rules_board_id_pattern_pk" PRIMARY KEY("board_id","pattern")
);
--> statement-breakpoint
ALTER TABLE "dependency_rule_changes" ADD CONSTRAINT "dependency_rule_changes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_rules" ADD CONSTRAINT "dependency_rules_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dependency_rule_changes_outcome_idx" ON "dependency_rule_changes" USING btree ("board_id","glob_id","pattern","cause");