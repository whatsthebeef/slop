-- Environments are dev only: the ones with a `role` (int, staging, prod on board 14) go. Data steps run first, while the roles
-- are still readable on boards.environments; the tables are dropped last.
CREATE TEMP TABLE "dropped_environments" ON COMMIT DROP AS
  SELECT b."id" AS "board_id", e.value->>'name' AS "name"
  FROM "boards" b, jsonb_array_elements(b."environments") AS e(value)
  WHERE jsonb_typeof(e.value) = 'object' AND e.value ? 'role' AND e.value->'role' <> 'null'::jsonb;--> statement-breakpoint
-- 1. Steps that waited for a dropped environment become the non-blocking downstream step (all states, titles kept).
UPDATE "human_steps" h SET "due" = 'downstream', "blocks" = '[]'::jsonb
  FROM "dropped_environments" d
  WHERE h."board_id" = d."board_id" AND h."due" = 'after_deploy:' || d."name";--> statement-breakpoint
-- 2. Boards keep only roleless environments, without the removed keys; the deploy projects of dropped names go.
UPDATE "boards" b SET "deploy" = jsonb_set(b."deploy", '{projects}', (b."deploy"->'projects') - ARRAY(SELECT d."name" FROM "dropped_environments" d WHERE d."board_id" = b."id"))
  WHERE b."deploy" IS NOT NULL AND jsonb_typeof(b."deploy"->'projects') = 'object';--> statement-breakpoint
UPDATE "boards" b SET "environments" = COALESCE((
    SELECT jsonb_agg(e.value - 'role' - 'deployKnown' - 'production' - 'subDefault' ORDER BY e.ord)
    FROM jsonb_array_elements(b."environments") WITH ORDINALITY AS e(value, ord)
    WHERE NOT (jsonb_typeof(e.value) = 'object' AND e.value ? 'role' AND e.value->'role' <> 'null'::jsonb)
  ), '[]'::jsonb)
  WHERE EXISTS (SELECT 1 FROM "dropped_environments" d WHERE d."board_id" = b."id")
     OR b."environments"::text ~ '"(deployKnown|production|subDefault|role)"';--> statement-breakpoint
-- 3. ATF runners lose the dropped names (one left with none is disabled, not deleted); environment-commit runs of the old model go.
UPDATE "atf_runners" r SET
    "enabled" = CASE WHEN jsonb_array_length(r."environments") > 0 AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(r."environments") n(name)
        WHERE n.name NOT IN (SELECT d."name" FROM "dropped_environments" d WHERE d."board_id" = r."board_id")) THEN false ELSE r."enabled" END,
    "environments" = COALESCE((
        SELECT jsonb_agg(n.name ORDER BY n.ord) FROM jsonb_array_elements_text(r."environments") WITH ORDINALITY n(name, ord)
        WHERE n.name NOT IN (SELECT d."name" FROM "dropped_environments" d WHERE d."board_id" = r."board_id")), '[]'::jsonb)
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(r."environments") n(name)
    WHERE n.name IN (SELECT d."name" FROM "dropped_environments" d WHERE d."board_id" = r."board_id"));--> statement-breakpoint
DELETE FROM "test_runs" WHERE "glob_id" IS NULL;--> statement-breakpoint
-- 4. Jobs of the removed effects: the environment check, and webhook deliveries that name a numeric deploy id.
DELETE FROM "outbox" WHERE "state" IN ('pending', 'failed')
  AND ("kind" = 'check_environment' OR ("kind" = 'deliver_atf_webhook' AND jsonb_typeof("effect"->'deployId') = 'number'));--> statement-breakpoint
-- 5. The tables.
DROP TABLE IF EXISTS "atf_batches" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "environment_deploys" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "glob_environments" CASCADE;
