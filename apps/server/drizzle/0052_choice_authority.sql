-- A choice weighs what its source weighs: records keep the decision tier, plans and attachments the approved-plan tier,
-- pasted meetings, threads and documents the discussion tier.
UPDATE "knowledge_items" AS k SET "authority" = CASE d."source_kind"
    WHEN 'implementation_plan' THEN 'decision'
    WHEN 'inbox' THEN 'discussion'
    ELSE 'approved_plan'
  END
FROM "decisions" AS d
WHERE d."item_id" = k."id";
