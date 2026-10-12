-- A merge failure used to leave the routine run watching, which blocked Pick up, Retrigger and Resolve conflict.
-- End the watching run of every glob that is already failed (idempotent: only a last run still watching is touched).
UPDATE "globs"
SET "data" = jsonb_set(
  "data",
  ARRAY['runs', (jsonb_array_length("data"->'runs') - 1)::text],
  ("data"->'runs'->-1) || jsonb_build_object(
    'state', 'ended',
    'outcome', 'failed',
    'endedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'failureReason', COALESCE("data"->'failure'->>'reason', 'Glob failed while the run was watching')
  )
)
WHERE "status" = 'failed'
  AND jsonb_typeof("data"->'runs') = 'array'
  AND jsonb_array_length("data"->'runs') > 0
  AND "data"->'runs'->-1->>'state' = 'watching';
