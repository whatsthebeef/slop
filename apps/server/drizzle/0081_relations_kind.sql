ALTER TABLE "relations" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'waits' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "relations_from_to_gate_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relations_from_to_gate_kind_idx" ON "relations" USING btree ("from_glob","to_glob","gate","kind");
