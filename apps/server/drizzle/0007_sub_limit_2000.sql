-- Raise the sub size limit from 300 to 2000 changed lines. Only boards still at the old default
-- change, so running it again is a no-op.
ALTER TABLE "boards" ALTER COLUMN "sub_max_changed_lines" SET DEFAULT 2000;--> statement-breakpoint
UPDATE "boards" SET "sub_max_changed_lines" = 2000 WHERE "sub_max_changed_lines" = 300;
