-- The KB pipeline's queue moves to the outbox: each open learning waiting for a step gets one `llm`-lane job for it
-- (`kb_route` without a target, `kb_draft` with a target and no draft; a document proposal is its own draft, and one
-- without a target is routed to its document with no model call). The
-- processing columns stay behind, unread. Items that failed carry over as failed jobs (an admin's Retry queues a fresh
-- one), except those that failed only because Bedrock was busy, which start again with no attempts spent (what the
-- startup requeue did). A claimed or backing-off item is due at once: every step is idempotent.
INSERT INTO "outbox" ("kind", "lane", "glob_id", "effect", "state", "attempts", "run_after", "last_error", "created_at")
SELECT
  q.kind,
  'llm',
  q.id,
  jsonb_build_object('kind', q.kind, 'globId', q.id),
  CASE WHEN q.failed AND NOT q.busy THEN 'failed' ELSE 'pending' END,
  CASE WHEN q.failed AND q.busy THEN 0 ELSE q.processing_attempts END,
  now(),
  CASE WHEN q.failed AND q.busy THEN NULL ELSE q.processing_error END,
  now()
FROM (
  SELECT
    p.id,
    p.processing_attempts,
    p.processing_error,
    p.created_at,
    CASE WHEN coalesce(jsonb_typeof(p.target), 'null') = 'null' THEN 'kb_route' ELSE 'kb_draft' END AS kind,
    p.processing = 'failed' AS failed,
    coalesce(p.processing_error ~* 'unable to process your request|too many requests|throttl|rate exceeded|service unavailable|model is not ready|waiting: bedrock busy', false) AS busy
  FROM "kb_proposals" p
  WHERE p.status = 'open'
    AND (
      coalesce(jsonb_typeof(p.target), 'null') = 'null'
      OR (coalesce(jsonb_typeof(p.document), 'null') = 'null' AND coalesce(jsonb_typeof(p.draft), 'null') = 'null')
    )
) q
ORDER BY q.created_at, q.id;
