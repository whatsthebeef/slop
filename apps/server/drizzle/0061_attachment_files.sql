ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "file" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_file_key_idx" ON "artifacts" USING btree (("file"->>'key')) WHERE "artifacts"."file" is not null;
