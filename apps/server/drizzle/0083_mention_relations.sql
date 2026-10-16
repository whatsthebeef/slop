-- A mentioned glob is no longer a card question: the relation scan adds the relation itself. Open mention rows go, and each glob that
-- had one is scanned again (one pending job per glob) so its mentions become relations, or are remembered as context. Failed-step rows stay.
INSERT INTO "outbox" ("kind", "lane", "glob_id", "effect")
SELECT 'scan_relations', 'llm', g."glob_id", jsonb_build_object('kind', 'scan_relations', 'globId', g."glob_id")
FROM (SELECT DISTINCT "glob_id" FROM "relation_scans" WHERE "kind" = 'mention' AND "state" = 'open') g
WHERE NOT EXISTS (
  SELECT 1 FROM "outbox" o WHERE o."kind" = 'scan_relations' AND o."glob_id" = g."glob_id" AND o."state" = 'pending' AND o."attempts" = 0
);--> statement-breakpoint
DELETE FROM "relation_scans" WHERE "kind" = 'mention' AND "state" = 'open';
