ALTER TABLE "human_steps" ADD COLUMN IF NOT EXISTS "why" text;--> statement-breakpoint
ALTER TABLE "human_steps" ADD COLUMN IF NOT EXISTS "permissions" text;--> statement-breakpoint
ALTER TABLE "human_steps" ADD COLUMN IF NOT EXISTS "commands" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "human_steps" ADD COLUMN IF NOT EXISTS "verify" text;