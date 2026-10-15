-- The size check only advises now (s15t200): it never turns a sub into a same. Revert the size escalations of open globs: the glob is a
-- sub again (only subs were ever escalated for size) and the escalation is cleared. Merged globs keep theirs as history. Data only, and
-- idempotent: a second run finds none.
UPDATE "globs"
SET "type" = 'sub', "data" = ("data" - 'escalation') || '{"type":"sub"}'::jsonb
WHERE "data"->'escalation'->>'criterion' = 'size'
  AND "status" NOT IN ('reviewing', 'signed_off', 'merging', 'merged');
