-- Supers can Merge and continue: every glob gets an empty list of PRs merged that way and no merge mode.
-- Only rows without the new fields are touched, so running it again changes nothing.
UPDATE "globs" SET "data" = "data" || '{"prs": []}'::jsonb WHERE NOT ("data" ? 'prs');
--> statement-breakpoint
UPDATE "globs" SET "data" = "data" || '{"mergeMode": null}'::jsonb WHERE NOT ("data" ? 'mergeMode');
