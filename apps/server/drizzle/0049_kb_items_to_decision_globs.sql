-- KB items become their decision globs (same `k` ID): each kb_proposals row becomes one glob (the item's fields as
-- attributes, how it relates to other learnings as links), its artifacts (the payload, draft, outcome, effect check),
-- attachments (evidence from near-duplicates, the merge note) and events, and the table goes. Drizzle runs pending
-- migrations in one transaction, so the copy and the drop commit together or not at all. The pipeline's outbox jobs
-- (0048) already name the items by ID and keep pointing at them. Mirrors of TypeScript rules (the title cut,
-- `decisionGlobTitle`; the payload, `proposalText`; the attribute and link layout, `kbAttributesOf` / `kbLinksOf`) are
-- held equal by the migration test.

-- The lock is taken by 0048, in the same transaction; taking it again is harmless, and holds when 0049 runs alone.
LOCK TABLE "kb_proposals" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

-- The old table enforced little inside its JSON: a timestamp that doesn't parse reads as missing (and falls back to the
-- row's own time) instead of aborting the deploy.
CREATE FUNCTION pg_temp.kb_ts(value text) RETURNS timestamptz LANGUAGE plpgsql AS $$
BEGIN
  RETURN value::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- A JSON array, or an empty one in its place.
CREATE FUNCTION pg_temp.kb_array(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE '[]'::jsonb END
$$;
--> statement-breakpoint

-- Development databases only (production never had decision globs before this): the wrapper globs earlier builds of
-- this change put in front of KB items are replaced, and other decision globs move from `source` to `origin`.
DELETE FROM "artifacts" WHERE "glob_id" IN (SELECT "id" FROM "kb_proposals")
  OR "glob_id" IN (SELECT "id" FROM "globs" WHERE "data"->>'category' = 'decision' AND coalesce("data"->'attributes'->'source'->>'kind', "data"->'attributes'->'origin'->>'kind') = 'kb_item');
--> statement-breakpoint
DELETE FROM "events" WHERE "glob_id" IN (SELECT "id" FROM "kb_proposals")
  OR "glob_id" IN (SELECT "id" FROM "globs" WHERE "data"->>'category' = 'decision' AND coalesce("data"->'attributes'->'source'->>'kind', "data"->'attributes'->'origin'->>'kind') = 'kb_item');
--> statement-breakpoint
DELETE FROM "globs" WHERE "id" IN (SELECT "id" FROM "kb_proposals")
  OR ("data"->>'category' = 'decision' AND coalesce("data"->'attributes'->'source'->>'kind', "data"->'attributes'->'origin'->>'kind') = 'kb_item');
--> statement-breakpoint
UPDATE "globs"
SET "data" = jsonb_set("data", '{attributes}', (("data"->'attributes') - 'source' - 'kbItemId') || jsonb_build_object('origin', "data"->'attributes'->'source'))
WHERE "data"->>'category' = 'decision' AND "data"->'attributes' ? 'source';
--> statement-breakpoint
UPDATE "globs"
SET "data" = jsonb_set("data", '{attributes}', ("data"->'attributes') - 'kbItemId')
WHERE "data"->>'category' = 'decision' AND "data"->'attributes' ? 'kbItemId';
--> statement-breakpoint

-- Each row with what its glob needs worked out once. Timestamps in JSON use toISOString()'s format.
CREATE TEMP TABLE "kb_move" ON COMMIT DROP AS
SELECT
  p.*,
  q.signed_off_at,
  to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_ts,
  to_char(q.signed_off_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS signed_off_ts,
  to_char(coalesce(q.signed_off_at, p.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_ts,
  CASE WHEN p.status = 'open' THEN 'planning' ELSE 'signed_off' END AS glob_status,
  -- Decided or closed learnings leave the board; an approval stays in Signed Off for 30 days.
  (p.status IN ('rejected', 'merged', 'suppressed', 'covered') OR (p.status = 'approved' AND coalesce(p.decided_at, p.created_at) < now() - interval '30 days')) AS archived,
  CASE
    WHEN t.line = '' THEN 'Untitled decision'
    WHEN length(t.line) > 120 THEN left(t.line, 117) || '...'
    ELSE t.line
  END AS title
FROM "kb_proposals" p
CROSS JOIN LATERAL (
  SELECT CASE
    -- A decision without its time (never written so, but not enforced) is dated as its submission.
    WHEN p.status IN ('approved', 'rejected') THEN coalesce(p.decided_at, p.created_at)
    WHEN p.status IN ('merged', 'suppressed', 'covered') THEN coalesce(pg_temp.kb_ts(p.merge_note->>'at'), p.created_at)
  END AS signed_off_at
) q
-- The first non-blank line of the statement, trimmed (`decisionGlobTitle`).
CROSS JOIN LATERAL (
  SELECT regexp_replace(coalesce(substring(p.statement from '\S[^\n]*'), ''), '\s+$', '') AS line
) t;
--> statement-breakpoint

INSERT INTO "globs" ("id", "board_id", "version", "status", "type", "group_name", "planner", "implementer", "creation_key", "data", "updated_at")
SELECT
  m.id,
  m.board_id,
  m.version,
  m.glob_status,
  'same',
  NULL,
  m.submitted_by,
  CASE WHEN m.status IN ('approved', 'rejected') THEN coalesce(m.decided_by, 'slop') END,
  'kb:' || m.id,
  jsonb_build_object(
    'id', m.id,
    'boardId', m.board_id,
    'title', m.title,
    'summary', m.statement,
    'type', 'same',
    'category', 'decision',
    'attributes', a.attributes,
    'links', l.links,
    'group', NULL,
    'environment', NULL,
    'status', m.glob_status,
    'version', m.version,
    'generation', 1,
    'creator', m.submitted_by,
    'planner', m.submitted_by,
    'implementer', CASE WHEN m.status IN ('approved', 'rejected') THEN coalesce(m.decided_by, 'slop') END,
    'labels', '{}'::jsonb,
    'checklists', '{}'::jsonb,
    'pr', NULL,
    'prs', '[]'::jsonb,
    'mergeMode', NULL,
    'headChecks', NULL
  ) || jsonb_build_object(
    'runs', '[]'::jsonb,
    'failure', NULL,
    'provisioning', 'none',
    'createdAt', m.created_ts,
    'updatedAt', m.updated_ts,
    'signedOffAt', m.signed_off_ts,
    'doingSince', NULL
  ),
  coalesce(m.signed_off_at, m.created_at)
FROM "kb_move" m
-- The decision attributes (`kbAttributesOf`, plus the rows' scope, origin, channel, outcome, archived and closedAs).
CROSS JOIN LATERAL (
  SELECT
    jsonb_build_object(
      'scope', CASE WHEN m.type = 'decision' THEN '{"kind": "project", "ref": null}'::jsonb ELSE '{"kind": "future_work", "ref": null}'::jsonb END,
      'origin', jsonb_build_object('kind', m.source),
      'channel', CASE WHEN m.source = 'mined' THEN 'mined' ELSE 'agent' END,
      'outcome', CASE
        WHEN m.status = 'approved' THEN jsonb_build_object('kind', 'accept', 'by', coalesce(m.decided_by, 'slop'), 'at', m.signed_off_ts)
          || CASE WHEN m.decision_reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason', m.decision_reason) END
        WHEN m.status = 'rejected' THEN jsonb_build_object('kind', 'reject', 'by', coalesce(m.decided_by, 'slop'), 'at', m.signed_off_ts)
          || CASE WHEN m.decision_reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason', m.decision_reason) END
        WHEN m.status IN ('merged', 'suppressed', 'covered') THEN jsonb_build_object('kind', 'closed', 'by', 'slop', 'at', m.signed_off_ts, 'reason', 'The knowledge pipeline closed the item as ' || m.status)
        ELSE 'null'::jsonb
      END,
      'kind', m.type,
      'sourceGlobs', m.source_glob_ids,
      'target', jsonb_build_object('suggested', m.suggested_target, 'routed', coalesce(m.target, 'null'::jsonb)),
      'evidenceCount', m.occurrence_count
    )
    || CASE WHEN m.archived THEN '{"archived": true}'::jsonb ELSE '{}'::jsonb END
    || CASE WHEN m.agent_set_version IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('agentSetVersion', m.agent_set_version) END
    || CASE WHEN coalesce(jsonb_typeof(m.signal), 'null') = 'null' THEN '{}'::jsonb ELSE jsonb_build_object('signal', m.signal) END
    || CASE WHEN m.catalog_candidate THEN '{"catalogCandidate": true}'::jsonb ELSE '{}'::jsonb END
    || CASE WHEN m.catalog_reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('catalogReason', m.catalog_reason) END
    || CASE WHEN m.status IN ('merged', 'suppressed', 'covered') THEN jsonb_build_object('closedAs', m.status) ELSE '{}'::jsonb END
    || CASE
      WHEN m.stale_since IS NULL AND m.stale_reason IS NULL AND m.stale_dismissed_at IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('stale', jsonb_build_object(
        'since', to_char(m.stale_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'reason', m.stale_reason,
        'dismissedAt', to_char(m.stale_dismissed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ))
    END
    || CASE WHEN coalesce(jsonb_typeof(m.document), 'null') = 'null' THEN '{}'::jsonb ELSE jsonb_build_object('document', m.document - 'content') END
    || CASE WHEN m.covered_by->>'kind' = 'knowledge' THEN jsonb_build_object('coveredByText', m.covered_by) ELSE '{}'::jsonb END
    || CASE
      WHEN coalesce(jsonb_typeof(m.possibly_covered_by), 'null') = 'object' AND coalesce(m.possibly_covered_by->>'kind', 'knowledge') = 'knowledge'
        THEN jsonb_build_object('possiblyCoveredByText', m.possibly_covered_by)
      ELSE '{}'::jsonb
    END
    || coalesce((
      SELECT jsonb_build_object('contradictsText', jsonb_agg(c.value ORDER BY c.n))
      FROM jsonb_array_elements(pg_temp.kb_array(m.contradicts)) WITH ORDINALITY c(value, n)
      WHERE c.value->>'kind' = 'knowledge'
      HAVING count(*) > 0
    ), '{}'::jsonb) AS attributes
) a
-- The links (`kbLinksOf`): what closed it, a hint naming another learning, contradictions (with their position among
-- all contradictions), pairs an admin kept apart.
CROSS JOIN LATERAL (
  SELECT coalesce(jsonb_agg(x.link ORDER BY x.ord, x.n), '[]'::jsonb) AS links
  FROM (
    SELECT 1 AS ord, 0::bigint AS n, jsonb_build_object('id', m.duplicate_of, 'kind', 'duplicate_of', 'source', 'pipeline') AS link WHERE m.duplicate_of IS NOT NULL
    UNION ALL
    SELECT 2, 0, jsonb_build_object('id', m.suppressed_by, 'kind', 'suppressed_by', 'source', 'pipeline') WHERE m.suppressed_by IS NOT NULL
    UNION ALL
    SELECT 3, 0, jsonb_build_object('id', m.covered_by->>'id', 'kind', 'covered_by', 'source', 'pipeline') WHERE m.covered_by->>'kind' = 'item'
    UNION ALL
    -- The hint's own keys only (`hintDetail`): its quotes, claim, which quote was short, a target hint, and `via`.
    SELECT 4, 0, jsonb_build_object('id', m.possibly_covered_by->>'id', 'kind', 'possibly_covered_by', 'source', 'pipeline', 'detail', jsonb_strip_nulls(jsonb_build_object(
      'quote', coalesce(m.possibly_covered_by->>'quote', ''),
      'shortQuote', true,
      'claim', m.possibly_covered_by->'claim',
      'ownQuote', m.possibly_covered_by->'ownQuote',
      'tooShort', m.possibly_covered_by->'tooShort',
      'alsoTarget', CASE WHEN jsonb_typeof(m.possibly_covered_by->'alsoTarget') = 'object'
        THEN jsonb_build_object('quote', coalesce(m.possibly_covered_by->'alsoTarget'->>'quote', ''), 'reason', coalesce(m.possibly_covered_by->'alsoTarget'->>'reason', '')) END,
      'via', m.possibly_covered_by->'via'
    )))
    WHERE m.possibly_covered_by->>'kind' = 'item' AND m.possibly_covered_by->>'id' IS NOT NULL
    UNION ALL
    SELECT 5, c.n, jsonb_build_object('id', c.value->>'ref', 'kind', 'contradicts', 'source', 'pipeline', 'detail', jsonb_build_object('note', c.value->'note', 'position', c.n - 1))
    FROM jsonb_array_elements(pg_temp.kb_array(m.contradicts)) WITH ORDINALITY c(value, n)
    WHERE c.value->>'kind' = 'item' AND c.value->>'ref' IS NOT NULL
    UNION ALL
    SELECT 6, k.n, jsonb_build_object('id', k.value, 'kind', 'kept_apart_from', 'source', 'explicit')
    FROM jsonb_array_elements_text(pg_temp.kb_array(m.kept_apart_from)) WITH ORDINALITY k(value, n)
  ) x
) l;
--> statement-breakpoint

-- The payload: the statement and its evidence (`proposalText`), or a proposed document's body.
INSERT INTO "artifacts" ("glob_id", "kind", "label", "version", "content", "provenance", "created_at")
SELECT
  m.id,
  'plan',
  '',
  1,
  CASE WHEN coalesce(jsonb_typeof(m.document), 'null') = 'null' THEN m.statement || E'\n\n## Evidence\n\n' || m.evidence ELSE m.document->>'content' END,
  jsonb_build_object('by', 'backfill', 'actor', m.submitted_by, 'runId', NULL, 'agentSetVersion', m.agent_set_version),
  m.created_at
FROM "kb_move" m;
--> statement-breakpoint

-- A document proposal's submission evidence (its payload is the document).
INSERT INTO "artifacts" ("glob_id", "kind", "label", "version", "content", "provenance", "created_at")
SELECT m.id, 'attachment', 'evidence', 1, m.evidence, jsonb_build_object('by', 'backfill', 'actor', m.submitted_by, 'runId', NULL, 'agentSetVersion', NULL), m.created_at
FROM "kb_move" m
WHERE coalesce(jsonb_typeof(m.document), 'null') <> 'null';
--> statement-breakpoint

-- The draft, with what it was made against and why.
INSERT INTO "artifacts" ("glob_id", "kind", "label", "version", "content", "provenance", "created_at")
SELECT
  m.id,
  'draft',
  '',
  1,
  m.draft->>'content',
  jsonb_build_object('by', 'backfill', 'actor', 'slop', 'runId', NULL, 'agentSetVersion', NULL, 'draft', jsonb_build_object(
    'section', m.draft->'section',
    'targetVersion', m.drafted_against_version,
    'target', coalesce(m.target, 'null'::jsonb),
    'rationale', m.rationale
  )),
  m.created_at
FROM "kb_move" m
WHERE coalesce(jsonb_typeof(m.draft), 'null') = 'object';
--> statement-breakpoint

-- What the approval did (or an agent's rejection).
INSERT INTO "artifacts" ("glob_id", "kind", "label", "version", "content", "provenance", "created_at")
SELECT
  m.id,
  'outcome',
  '',
  1,
  m.outcome::text,
  jsonb_build_object('by', 'backfill', 'actor', coalesce(m.decided_by, 'slop'), 'runId', NULL, 'agentSetVersion', NULL, 'kbOutcome', m.outcome),
  coalesce(m.decided_at, m.created_at)
FROM "kb_move" m
WHERE coalesce(jsonb_typeof(m.outcome), 'null') = 'object';
--> statement-breakpoint

-- Whether the approved change worked.
INSERT INTO "artifacts" ("glob_id", "kind", "label", "version", "content", "provenance", "created_at")
SELECT
  m.id,
  'effect_check',
  '',
  1,
  m.effect_check::text,
  jsonb_build_object('by', 'backfill', 'actor', 'slop', 'runId', NULL, 'agentSetVersion', NULL, 'effectCheck', m.effect_check),
  coalesce(m.decided_at, m.created_at)
FROM "kb_move" m
WHERE coalesce(jsonb_typeof(m.effect_check), 'null') = 'object';
--> statement-breakpoint

-- Evidence near-duplicates added, in order: one attachment each (a second from the same learning gets `#2`, and so on).
INSERT INTO "artifacts" ("glob_id", "kind", "label", "version", "content", "provenance", "created_at")
SELECT
  e.id,
  'attachment',
  'evidence:' || e.item_id || CASE WHEN e.repeat > 1 THEN '#' || e.repeat ELSE '' END,
  1,
  coalesce(e.value->>'evidence', ''),
  jsonb_build_object('by', 'backfill', 'actor', coalesce(e.value->>'submittedBy', e.submitted_by), 'runId', NULL, 'agentSetVersion', NULL,
    'evidence', jsonb_build_object('itemId', e.item_id, 'globIds', pg_temp.kb_array(e.value->'globIds'))),
  -- An entry without a usable time is dated as the learning's submission.
  coalesce(pg_temp.kb_ts(e.value->>'at'), e.created_at)
FROM (
  SELECT m.id, m.submitted_by, m.created_at, x.value, x.n, coalesce(x.value->>'itemId', '') AS item_id,
    row_number() OVER (PARTITION BY m.id, coalesce(x.value->>'itemId', '') ORDER BY x.n) AS repeat
  FROM "kb_move" m
  CROSS JOIN LATERAL jsonb_array_elements(pg_temp.kb_array(m.extra_evidence)) WITH ORDINALITY x(value, n)
) e
ORDER BY e.id, e.n;
--> statement-breakpoint

-- The verified quotes the pipeline closed the learning on.
INSERT INTO "artifacts" ("glob_id", "kind", "label", "version", "content", "provenance", "created_at")
SELECT
  m.id,
  'attachment',
  'merge_note',
  1,
  'Closed by ' || coalesce(m.merge_note->>'by', '') || ' at ' || coalesce(m.merge_note->>'at', '') || ': this learning says "' || coalesce(m.merge_note->>'quote', '') || '"; the other says "' || coalesce(m.merge_note->>'survivorQuote', '') || '".',
  jsonb_build_object('by', 'backfill', 'actor', 'slop', 'runId', NULL, 'agentSetVersion', NULL, 'mergeNote', m.merge_note),
  coalesce(m.signed_off_at, m.created_at)
FROM "kb_move" m
WHERE coalesce(jsonb_typeof(m.merge_note), 'null') = 'object';
--> statement-breakpoint

-- History: created when submitted; decided or closed learnings also moved to Signed Off with their outcome.
INSERT INTO "events" ("glob_id", "type", "actor", "at", "data")
SELECT m.id, 'GlobCreated', m.submitted_by, m.created_at,
  '{"type": "same", "category": "decision", "group": null, "environment": null, "status": "planning"}'::jsonb
FROM "kb_move" m
ORDER BY m.created_at, m.id;
--> statement-breakpoint
INSERT INTO "events" ("glob_id", "type", "actor", "at", "data")
SELECT e.id, e.type, e.actor, e.at, e.data
FROM (
  SELECT m.id, 1 AS step, 'StatusChanged' AS type, CASE WHEN m.status IN ('approved', 'rejected') THEN m.decided_by END AS actor, m.signed_off_at AS at,
    '{"from": "planning", "to": "signed_off"}'::jsonb AS data
  FROM "kb_move" m WHERE m.status <> 'open'
  UNION ALL
  SELECT m.id, 2, 'DecisionDecided', CASE WHEN m.status IN ('approved', 'rejected') THEN m.decided_by END, m.signed_off_at,
    -- The shapes the decision rows write: `decisionApproved`/`decisionRejected` ({outcome, via}) and `closeDecision`
    -- ({outcome, closedAs, link}).
    CASE WHEN m.status IN ('approved', 'rejected') THEN jsonb_build_object(
      'outcome', jsonb_build_object('kind', CASE m.status WHEN 'approved' THEN 'accept' ELSE 'reject' END)
        || CASE WHEN m.decision_reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason', m.decision_reason) END,
      'via', 'migration'
    ) ELSE jsonb_build_object(
      'outcome', jsonb_build_object('kind', 'closed', 'reason', 'The knowledge pipeline closed the item as ' || m.status),
      'closedAs', m.status,
      'link', CASE
        WHEN m.duplicate_of IS NOT NULL THEN jsonb_build_object('id', m.duplicate_of, 'kind', 'duplicate_of', 'source', 'pipeline')
        WHEN m.suppressed_by IS NOT NULL THEN jsonb_build_object('id', m.suppressed_by, 'kind', 'suppressed_by', 'source', 'pipeline')
        WHEN m.covered_by->>'kind' = 'item' THEN jsonb_build_object('id', m.covered_by->>'id', 'kind', 'covered_by', 'source', 'pipeline')
        ELSE 'null'::jsonb
      END
    ) END
  FROM "kb_move" m WHERE m.status <> 'open'
) e
ORDER BY e.at, e.id, e.step;
--> statement-breakpoint

-- The shared `k` counter is never behind an item's number (defensive: items always took it from the counter).
INSERT INTO "id_counters" ("board_id", "letter", "n")
SELECT m.board_id, 'k', max((substring(m.id from 'k([0-9]+)$'))::integer)
FROM "kb_move" m
WHERE m.id ~ 'k[0-9]+$'
GROUP BY m.board_id
ON CONFLICT ("board_id", "letter") DO UPDATE SET "n" = GREATEST("id_counters"."n", EXCLUDED."n");
--> statement-breakpoint

DROP TABLE "kb_proposals" CASCADE;
