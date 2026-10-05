ALTER TABLE "boards" ALTER COLUMN "sub_max_changed_lines" SET DEFAULT 2000;--> statement-breakpoint
UPDATE "boards" SET "sub_max_changed_lines" = 2000 WHERE "sub_max_changed_lines" = 300;
