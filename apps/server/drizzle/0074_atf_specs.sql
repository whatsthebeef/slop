-- Test plans and per-spec ATF results (s15f163). Additive and idempotent: tables, columns and the constraints are created only when missing.
CREATE TABLE IF NOT EXISTS "atf_batches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"environment" text NOT NULL,
	"sha" text NOT NULL,
	"specs" jsonb NOT NULL,
	"greps" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "test_run_specs" (
	"test_run_id" bigint NOT NULL,
	"spec" text NOT NULL,
	"status" text NOT NULL,
	"tests" integer DEFAULT 0 NOT NULL,
	"failed_tests" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	CONSTRAINT "test_run_specs_test_run_id_spec_pk" PRIMARY KEY("test_run_id","spec")
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "atf" jsonb;--> statement-breakpoint
ALTER TABLE "environment_deploys" ADD COLUMN IF NOT EXISTS "checked_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "atf_batches" ADD CONSTRAINT "atf_batches_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "test_run_specs" ADD CONSTRAINT "test_run_specs_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "atf_batches_deploy_idx" ON "atf_batches" USING btree ("board_id","environment","sha");
