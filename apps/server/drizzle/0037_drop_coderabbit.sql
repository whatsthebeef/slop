DROP TABLE IF EXISTS "code_review_comments" CASCADE;--> statement-breakpoint
DELETE FROM "review_findings" WHERE "source" = 'coderabbit';--> statement-breakpoint
DELETE FROM "review_sources" WHERE "kind" = 'coderabbit_comment';--> statement-breakpoint
DELETE FROM "outbox" WHERE "kind" = 'request_code_review';--> statement-breakpoint
DELETE FROM "knowledge_items" WHERE "source_type" = 'code_review';
