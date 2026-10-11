CREATE TABLE IF NOT EXISTS "board_risk_areas" (
	"board_id" integer NOT NULL,
	"name" text NOT NULL,
	"path_patterns" jsonb NOT NULL,
	"why" text NOT NULL,
	"source" text NOT NULL,
	"strength" integer DEFAULT 0 NOT NULL,
	"clean_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "board_risk_areas_board_id_name_pk" PRIMARY KEY("board_id","name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_area_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"area_name" text,
	"kind" text NOT NULL,
	"glob_id" text,
	"cause" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "sub_limit_step" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "sub_limit_changes" ADD COLUMN IF NOT EXISTS "step" integer DEFAULT 250 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "board_risk_areas" ADD CONSTRAINT "board_risk_areas_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "risk_area_changes" ADD CONSTRAINT "risk_area_changes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "risk_area_changes_outcome_idx" ON "risk_area_changes" USING btree ("board_id","glob_id","cause","area_name");
