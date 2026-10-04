ALTER TABLE "boards" ADD COLUMN "run_no_progress_hours" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "run_ready_hours" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "sub_max_changed_lines" integer DEFAULT 300 NOT NULL;