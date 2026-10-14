-- A split is a scope cut now (s15f144): no sign-off gate from the original on its parts, no auto-start between parts, and a size flag
-- only advises, so nothing is held for it. Data only, and idempotent: every statement matches only what is still to be changed.
-- 1. Resolve every open split sign-off relation (marked dismissed, so the original signs off on its own and nothing stays held).
-- Split start relations between old parts stay: they are ordinary needs of globs that exist.
UPDATE "relations"
SET "dismissed_at" = now()
WHERE "source" = 'split' AND "gate" = 'sign_off' AND "dismissed_at" IS NULL AND "overridden_at" IS NULL;--> statement-breakpoint
-- 2. Clear `autoStart` on globs that had it only from a split (every part carries a GlobSplit event). A part in Planning that waited
-- to start by itself stops waiting and keeps its needs, as when a person turned it off.
UPDATE "globs" g
SET "data" = CASE
  WHEN g."status" = 'planning' THEN (g."data" - 'autoStart') - 'waiting'
  ELSE g."data" - 'autoStart'
END
WHERE g."data"->'autoStart' IS NOT NULL
  AND EXISTS (SELECT 1 FROM "events" e WHERE e."glob_id" = g."id" AND e."type" = 'GlobSplit');--> statement-breakpoint
-- 3. A glob held in Planning only for its unanswered oversized flag (waiting, flagged, with nothing it still starts after) is no longer
-- held: it shows Start like any glob. One that still has a start relation stays held for it and starts when that merges.
-- A flagged `sub` becomes `same` (what escalateToSame does), so a legacy glob held for the flag is not left a sub that was never split.
UPDATE "globs" g
SET "data" = g."data" - 'waiting', "type" = CASE WHEN g."type" = 'sub' THEN 'same' ELSE g."type" END
WHERE g."status" = 'planning'
  AND jsonb_typeof(g."data"->'waiting') = 'object'
  AND EXISTS (SELECT 1 FROM "glob_size_checks" c WHERE c."glob_id" = g."id" AND c."flagged" AND c."decision" IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "relations" r
    WHERE r."from_glob" = g."id" AND r."gate" = 'start' AND r."dismissed_at" IS NULL AND r."overridden_at" IS NULL
  );--> statement-breakpoint
-- 4. Keep whole is gone: a flag was never answered that way any more. Old answers are cleared so the stored decisions read as `split` or none
-- (the size learning reads merged outcomes, not this field).
UPDATE "glob_size_checks"
SET "decision" = NULL, "decided_by" = NULL, "decided_at" = NULL
WHERE "decision" = 'kept_whole';
