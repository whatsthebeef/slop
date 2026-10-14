CREATE TABLE IF NOT EXISTS "relations" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"from_glob" text NOT NULL,
	"to_glob" text NOT NULL,
	"gate" text NOT NULL,
	"until" text NOT NULL,
	"reason" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"dismissed_at" timestamp with time zone,
	"dismissed_plan_hash" text,
	"overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relations" ADD CONSTRAINT "relations_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relations_from_to_gate_idx" ON "relations" USING btree ("from_glob","to_glob","gate");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relations_board_idx" ON "relations" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relations_from_idx" ON "relations" USING btree ("from_glob");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relations_to_idx" ON "relations" USING btree ("to_glob");--> statement-breakpoint
-- Backfill (idempotent: every statement skips what already exists, so it can run again).
-- 1. What a person set as `after`: start until merged. Targets that are not a glob on the same board, and a glob after itself, are skipped.
INSERT INTO "relations" ("id", "board_id", "from_glob", "to_glob", "gate", "until", "reason", "evidence", "source", "created_at")
SELECT 'rel_' || gen_random_uuid()::text, g.board_id, g.id, a.to_id, 'start', 'merged', NULL, '[]'::jsonb, 'person',
  COALESCE(NULLIF(g.data->>'createdAt', '')::timestamptz, now())
FROM "globs" g
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(g.data->'after') = 'array' THEN g.data->'after' ELSE '[]'::jsonb END) AS a(to_id)
JOIN "globs" t ON t.id = a.to_id AND t.board_id = g.board_id
WHERE a.to_id <> g.id
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 2. Recorded needs (learned, inferred, explicit): start until merged, with the source, the reason (`evidence`) and the paths kept.
-- A need a person dismissed keeps its plan hash; one that Start now overrode is marked overridden. Overlap entries (no kind, or `overlaps`) stay in the JSON and are not copied.
INSERT INTO "relations" ("id", "board_id", "from_glob", "to_glob", "gate", "until", "reason", "evidence", "source", "dismissed_at", "dismissed_plan_hash", "overridden_at", "created_at")
SELECT 'rel_' || gen_random_uuid()::text, g.board_id, g.id, e.entry->>'id', 'start', 'merged',
  NULLIF(e.entry->>'evidence', ''),
  CASE WHEN jsonb_typeof(e.entry->'paths') = 'array' THEN e.entry->'paths' ELSE '[]'::jsonb END,
  CASE e.entry->>'source' WHEN 'learned' THEN 'learned' WHEN 'inferred' THEN 'inferred' ELSE 'person' END,
  CASE WHEN e.entry->>'overridden' = 'true' AND e.entry->>'dismissedPlanHash' IS NOT NULL THEN now() END,
  CASE WHEN e.entry->>'overridden' = 'true' THEN e.entry->>'dismissedPlanHash' END,
  CASE WHEN e.entry->>'overridden' = 'true' AND e.entry->>'dismissedPlanHash' IS NULL THEN now() END,
  COALESCE(NULLIF(g.data->>'createdAt', '')::timestamptz, now())
FROM "globs" g
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(g.data->'impliedAfter') = 'array' THEN g.data->'impliedAfter' ELSE '[]'::jsonb END) AS e(entry)
JOIN "globs" t ON t.id = e.entry->>'id' AND t.board_id = g.board_id
WHERE e.entry->>'kind' = 'needs' AND e.entry->>'id' <> g.id
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 3. Splits: the glob that was cut can't be signed off until each other part has merged (sign off until merged). Read from the GlobSplit events
-- (every part has one with the same source and parts); a source already signed off, a part that no longer exists and the source itself are skipped.
INSERT INTO "relations" ("id", "board_id", "from_glob", "to_glob", "gate", "until", "reason", "evidence", "source", "created_at")
SELECT 'rel_' || gen_random_uuid()::text, src.board_id, src.id, p.part_id, 'sign_off', 'merged', 'split part', '[]'::jsonb, 'split', MIN(ev.at)
FROM "events" ev
JOIN "globs" src ON src.id = ev.data->>'source' AND src.status <> 'signed_off'
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(ev.data->'parts') = 'array' THEN ev.data->'parts' ELSE '[]'::jsonb END) AS p(part_id)
JOIN "globs" t ON t.id = p.part_id AND t.board_id = src.board_id
WHERE ev.type = 'GlobSplit' AND p.part_id <> src.id
GROUP BY src.board_id, src.id, p.part_id
ON CONFLICT DO NOTHING;
