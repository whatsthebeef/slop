ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "auto_investigate" boolean DEFAULT true NOT NULL;
