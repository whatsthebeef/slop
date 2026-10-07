-- Mined signals: the signal behind a mined KB item (kb_proposals.signal), one row per board and signal
-- key for the re-raise rules (kb_signals), and per-board jobs with their last run and a lease (board_jobs).
-- Idempotent.
CREATE TABLE IF NOT EXISTS "board_jobs" (
	"board_id" integer NOT NULL,
	"job" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_result" jsonb,
	"running_until" timestamp with time zone,
	CONSTRAINT "board_jobs_board_id_job_pk" PRIMARY KEY("board_id","job"),
	CONSTRAINT "board_jobs_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_signals" (
	"board_id" integer NOT NULL,
	"key" text NOT NULL,
	"item_id" text,
	"last_figures" jsonb,
	"last_measured_at" timestamp with time zone,
	"raised_at" timestamp with time zone,
	"below_threshold_runs" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "kb_signals_board_id_key_pk" PRIMARY KEY("board_id","key"),
	CONSTRAINT "kb_signals_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "kb_proposals" ADD COLUMN IF NOT EXISTS "signal" jsonb;
