UPDATE "globs" SET "data" = "data" - 'summary' WHERE "data" ? 'summary';--> statement-breakpoint
ALTER TABLE "intake_snapshots" DROP COLUMN IF EXISTS "summary";
