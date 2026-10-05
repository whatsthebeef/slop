-- Board readiness: the items slop cannot check, ticked by an admin.
ALTER TABLE "boards" ADD COLUMN "readiness_ticks" jsonb DEFAULT '{}'::jsonb NOT NULL;