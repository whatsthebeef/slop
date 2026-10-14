ALTER TABLE "size_threshold_changes" ADD COLUMN "from_parallel" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "size_threshold_changes" ADD COLUMN "to_parallel" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "size_thresholds" ADD COLUMN "min_parallel" integer DEFAULT 2 NOT NULL;