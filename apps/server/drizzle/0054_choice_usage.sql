CREATE TABLE "choice_usage" (
	"board_id" integer NOT NULL,
	"decision_id" bigint NOT NULL,
	"day" date NOT NULL,
	"glob_id" text DEFAULT '' NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "choice_usage_decision_id_day_glob_id_pk" PRIMARY KEY("decision_id","day","glob_id")
);
--> statement-breakpoint
ALTER TABLE "choice_usage" ADD CONSTRAINT "choice_usage_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "choice_usage" ADD CONSTRAINT "choice_usage_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "choice_usage_board_day_idx" ON "choice_usage" USING btree ("board_id","day");