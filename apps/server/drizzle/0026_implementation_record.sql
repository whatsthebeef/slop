-- One implementation record per glob (stored as kind 'implementation_plan'). A glob's latest postplan becomes the
-- record's next version; when the glob also has an implementation plan (a super's decision log), its latest version is
-- kept below the postplan in the same document. The old rows stay as history. Idempotent.
INSERT INTO "artifacts" ("glob_id", "kind", "label", "version", "content", "link", "commit_sha", "provenance", "created_at")
SELECT p."glob_id", 'implementation_plan', '',
	COALESCE((SELECT max(i."version") FROM "artifacts" i WHERE i."glob_id" = p."glob_id" AND i."kind" = 'implementation_plan' AND i."label" = ''), 0) + 1,
	'> Migrated from the postplan' ||
		CASE WHEN li."content" IS NULL THEN '' ELSE ' and the decision log' END ||
		'; the next update rewrites it in the implementation record format.' || E'\n\n' || p."content" ||
		CASE WHEN li."content" IS NULL THEN '' ELSE E'\n\n## Decision log (earlier record)\n\n' || li."content" END,
	NULL, p."commit_sha",
	jsonb_build_object('by', 'backfill', 'actor', p."provenance"->>'actor', 'runId', NULL, 'agentSetVersion', NULL),
	GREATEST(p."created_at", COALESCE(li."created_at", p."created_at"))
FROM "artifacts" p
LEFT JOIN LATERAL (
	SELECT i."content", i."created_at" FROM "artifacts" i
	WHERE i."glob_id" = p."glob_id" AND i."kind" = 'implementation_plan' AND i."label" = ''
	ORDER BY i."version" DESC LIMIT 1
) li ON true
WHERE p."kind" = 'postplan' AND p."label" = ''
	AND p."version" = (SELECT max(x."version") FROM "artifacts" x WHERE x."glob_id" = p."glob_id" AND x."kind" = 'postplan' AND x."label" = '')
	AND NOT EXISTS (
		SELECT 1 FROM "artifacts" m
		WHERE m."glob_id" = p."glob_id" AND m."kind" = 'implementation_plan' AND m."label" = ''
			AND m."provenance"->>'by' = 'backfill' AND m."created_at" >= p."created_at"
	);
