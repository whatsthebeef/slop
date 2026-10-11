CREATE TABLE "escalation_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"glob_id" text,
	"criterion" text NOT NULL,
	"outcome" text NOT NULL,
	"weight" integer NOT NULL,
	"cause" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "escalation_records" ADD CONSTRAINT "escalation_records_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "escalation_records_outcome_idx" ON "escalation_records" USING btree ("board_id","glob_id","outcome");