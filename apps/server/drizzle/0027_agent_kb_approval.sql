ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "agent_kb_approval" text DEFAULT 'docs' NOT NULL;
