-- The board orders its lists by when each glob entered the list (`listSince` on the glob document). Backfills it for the
-- existing globs: the time of the last StatusChanged event that moved the glob into its current list, else (no such event)
-- the time it entered Doing (`doingSince`), was signed off (`signedOffAt`), was created, or (a document without those) was last updated. Idempotent: a glob that already
-- has `listSince` is left as it is.
UPDATE "globs" g
SET "data" = jsonb_set(
	g."data",
	'{listSince}',
	to_jsonb(to_char(
		COALESCE(
			(
				SELECT max(e."at")
				FROM "events" e
				WHERE e."glob_id" = g."id"
					AND e."type" = 'StatusChanged'
					AND (CASE e."data"->>'to' WHEN 'planning' THEN 'planning' WHEN 'reviewing' THEN 'reviewing' WHEN 'signed_off' THEN 'signed_off' ELSE 'doing' END)
						= (CASE g."status" WHEN 'planning' THEN 'planning' WHEN 'reviewing' THEN 'reviewing' WHEN 'signed_off' THEN 'signed_off' ELSE 'doing' END)
					AND (CASE e."data"->>'from' WHEN 'planning' THEN 'planning' WHEN 'reviewing' THEN 'reviewing' WHEN 'signed_off' THEN 'signed_off' ELSE 'doing' END)
						<> (CASE e."data"->>'to' WHEN 'planning' THEN 'planning' WHEN 'reviewing' THEN 'reviewing' WHEN 'signed_off' THEN 'signed_off' ELSE 'doing' END)
			),
			CASE WHEN g."status" NOT IN ('planning', 'reviewing', 'signed_off') THEN (g."data"->>'doingSince')::timestamptz END,
			CASE WHEN g."status" = 'signed_off' THEN (g."data"->>'signedOffAt')::timestamptz END,
			(g."data"->>'createdAt')::timestamptz,
			g."updated_at"
		) AT TIME ZONE 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
	))
)
WHERE g."data" IS NOT NULL AND g."data"->>'listSince' IS NULL;
