-- The `decision` learning type is gone: what a person decides is a decision glob, and what slop extracts from the work is a choice.
-- Learnings that were of type `decision` become `pattern`; their scope and everything else stay as they are.
UPDATE "globs"
SET "data" = jsonb_set("data", '{attributes,kind}', '"pattern"')
WHERE "data"->>'category' = 'decision'
  AND "data"->'attributes'->>'kind' = 'decision';
