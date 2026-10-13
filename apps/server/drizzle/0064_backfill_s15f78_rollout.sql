-- s15f78 (file attachments) merged and signed off before human steps existed, so its rollout lived in a "Rollout script"
-- attachment that nobody was told about. Gives it the steps as open rollout steps. They hold back its dependants only: the
-- glob stays signed off. Idempotent: fixed ids, and a step a person has ticked or dismissed is left as it is. No-op where
-- s15f78 doesn't exist.
INSERT INTO "human_steps" ("id", "board_id", "glob_id", "kind", "title", "detail", "who", "due", "state", "blocks", "check", "script", "origin", "created_by", "created_at")
SELECT s."id", g."board_id", g."id", 'rollout', s."title", s."detail", 'anyone', 'after_merge', 'open', '["dependants"]'::jsonb, s."check",
	s."script"::jsonb, 'backfill', 'backfill', now()
FROM "globs" g
CROSS JOIN (VALUES
	('hs_backfill_s15f78_1', 'Deploy slop-prod-host with the attachments bucket and queue', 'From ~/dev/slop with an AWS session, run the script in the "Rollout script" attachment: it shows the `cdk diff` and asks before `cdk deploy slop-prod-host` (use infra/deploy/host-deploy.sh where it fits).', 'The stack outputs include AttachmentsBucketName and AttachmentsQueueUrl.', '{"artifact": "Rollout script"}'),
	('hs_backfill_s15f78_2', 'Add ATTACHMENTS_BUCKET, ATTACHMENTS_QUEUE_URL and ATTACHMENTS_REGION to /slop/prod/server-env', 'The same script writes them from the stack outputs (infra/deploy/server-env.sh does it by hand).', '`aws ssm get-parameter --name /slop/prod/server-env` lists the three variables.', '{"artifact": "Rollout script"}'),
	('hs_backfill_s15f78_3', 'Redeploy slop so the server reads the new environment', 'The script starts the deploy build (`aws codebuild start-build`) after the environment changes.', 'fileAttachments', '{"artifact": "Rollout script"}'),
	('hs_backfill_s15f78_4', 'Allow the attachments bucket host in claude.ai code execution network settings', 'In claude.ai, Settings, code execution network access: add the bucket''s S3 host so the slop-attach skill can upload.', NULL, NULL),
	('hs_backfill_s15f78_5', 'Install the slop-attach skill in the Claude app', 'Download /api/boards/15/skills/slop-attach.zip and add it as a skill.', 'Ask Claude to attach a file to a glob: it runs upload.sh and the file shows as stored.', NULL)
) AS s("id", "title", "detail", "check", "script")
WHERE g."id" = 's15f78'
ON CONFLICT ("id") DO NOTHING;
