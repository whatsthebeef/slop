-- Branch deploys: one row per request, queued per environment; boards gain their deploy integration.
CREATE TABLE "deploys" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"environment" text NOT NULL,
	"glob_id" text NOT NULL,
	"sha" text NOT NULL,
	"state" text NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"provider_ref" text,
	"url" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "deploy" jsonb;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deploys_board_env_state_idx" ON "deploys" USING btree ("board_id","environment","state");--> statement-breakpoint
CREATE INDEX "deploys_glob_requested_idx" ON "deploys" USING btree ("glob_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deploys_provider_ref_idx" ON "deploys" USING btree ("provider_ref");