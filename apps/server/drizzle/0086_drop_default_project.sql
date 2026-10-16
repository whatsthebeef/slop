-- The deploy integration no longer has a default project: each environment that takes branch deploys names its own.
-- An environment without a project gets the old default as its own, then the default goes.
UPDATE "boards" b SET "deploy" = jsonb_set(
    b."deploy" - 'defaultProject',
    '{projects}',
    COALESCE(b."deploy"->'projects', '{}'::jsonb) || COALESCE((
      SELECT jsonb_object_agg(e.value->>'name', b."deploy"->>'defaultProject')
      FROM jsonb_array_elements(b."environments") AS e(value)
      WHERE jsonb_typeof(e.value) = 'object'
        AND COALESCE((e.value->>'allowBranchDeploy')::boolean, false)
        AND COALESCE(b."deploy"->'projects'->>(e.value->>'name'), '') = ''
        AND COALESCE(b."deploy"->>'defaultProject', '') <> ''
    ), '{}'::jsonb))
  WHERE b."deploy" IS NOT NULL AND b."deploy"->>'provider' = 'codebuild';
