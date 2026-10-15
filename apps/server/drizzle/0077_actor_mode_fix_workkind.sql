-- Actor and mode are derived from category and type, so only the fix flag and the work kind are stored. Backfill them from the
-- category: a bug fixes something, a feature is R&D, tasks and bugs are maintenance; inferred, no reason. Decisions and actions
-- are left alone (readers default them). Idempotent: rows that already have `fix` are skipped.
UPDATE "globs" SET "data" = "data" || jsonb_build_object(
  'fix', "data"->>'category' = 'bug',
  'fixSource', 'inferred',
  'workKind', CASE WHEN "data"->>'category' = 'feature' THEN 'rnd' ELSE 'maintenance' END,
  'workKindSource', 'inferred',
  'inferenceReason', NULL::text
) WHERE "data"->>'category' IN ('feature', 'task', 'bug') AND NOT ("data" ? 'fix');
