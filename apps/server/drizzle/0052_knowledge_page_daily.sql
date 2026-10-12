ALTER TABLE "boards" ALTER COLUMN "knowledge_page_interval_minutes" SET DEFAULT 1440;--> statement-breakpoint
UPDATE "boards" SET "knowledge_page_interval_minutes" = 1440 WHERE "knowledge_page_interval_minutes" = 60;
