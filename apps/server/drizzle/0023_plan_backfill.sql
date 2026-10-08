INSERT INTO "artifacts" ("glob_id", "kind", "label", "version", "content", "link", "commit_sha", "provenance", "created_at")
SELECT g."id", 'plan', '', 1, g."data"->>'summary', NULL, NULL,
	jsonb_build_object('by', 'backfill', 'actor', g."planner", 'runId', NULL, 'agentSetVersion', NULL),
	COALESCE((g."data"->>'createdAt')::timestamptz, g."updated_at")
FROM "globs" g
WHERE btrim(COALESCE(g."data"->>'summary', '')) <> ''
	AND NOT EXISTS (SELECT 1 FROM "artifacts" a WHERE a."glob_id" = g."id" AND a."kind" = 'plan' AND a."label" = '');
