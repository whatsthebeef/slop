-- Sign-off labels gain review checklists: the old `added` state (signed off) becomes `approved`,
-- and `added` now means the reviewer added checklist items. Every glob gets an empty checklist map.
-- Each statement only touches rows from before this migration (no checklists yet; label events
-- without the new `items`/`open` fields), so running it again can't approve labels waiting on developers.
UPDATE "globs"
SET "data" = jsonb_set(
  "data",
  '{labels}',
  coalesce(
    (
      SELECT jsonb_object_agg(l.key, CASE WHEN l.value = '"added"'::jsonb THEN '"approved"'::jsonb ELSE l.value END)
      FROM jsonb_each(coalesce("data"->'labels', '{}'::jsonb)) AS l
    ),
    '{}'::jsonb
  )
)
WHERE "data"->'checklists' IS NULL;
--> statement-breakpoint
UPDATE "globs" SET "data" = "data" || '{"checklists": {}}'::jsonb WHERE "data"->'checklists' IS NULL;
--> statement-breakpoint
-- The event log keeps the meaning of past label changes under the new names.
UPDATE "events" SET "data" = jsonb_set("data", '{from}', '"approved"'::jsonb)
WHERE "type" = 'LabelChanged' AND "data"->>'from' = 'added' AND "data"->'items' IS NULL AND "data"->'open' IS NULL;
--> statement-breakpoint
UPDATE "events" SET "data" = jsonb_set("data", '{to}', '"approved"'::jsonb)
WHERE "type" = 'LabelChanged' AND "data"->>'to' = 'added' AND "data"->'items' IS NULL AND "data"->'open' IS NULL;
