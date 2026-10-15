ALTER TABLE "globs" ALTER COLUMN "type" DROP NOT NULL;--> statement-breakpoint
-- Decision globs have no type (it only says how code work is done): they were stored as `same`. Idempotent: a second run finds none.
UPDATE "globs" SET "type" = NULL, "data" = jsonb_set("data", '{type}', 'null'::jsonb) WHERE "data"->>'category' = 'decision' AND ("type" IS NOT NULL OR "data"->>'type' IS NOT NULL);
