import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgres://slop:slop@localhost:5432/slop'),
  /** The public URL of this server, used for OAuth metadata and cookies. */
  PUBLIC_URL: z.string().default('http://localhost:3000'),
  /** `dev` signs people in by email with no password; never use it outside a laptop. */
  AUTH_MODE: z.enum(['dev', 'cognito']).default('dev'),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_REGION: z.string().optional(),
  COGNITO_DOMAIN: z.string().optional(),
  /** App client IDs whose access tokens slop accepts (board, Claude connector, Claude Code). */
  COGNITO_CLIENT_IDS: z.string().optional(),
  COGNITO_BOARD_CLIENT_ID: z.string().optional(),
  COGNITO_BOARD_CLIENT_SECRET: z.string().optional(),
  /** Folder with the built web app, served by the same container. */
  WEB_DIST: z.string().optional(),
  MIGRATIONS_DIR: z.string().default('drizzle'),
  /** Where the manifest flow stores the GitHub App's credentials locally (gitignored). */
  GITHUB_APP_FILE: z.string().default('.github-app.json'),
  /** The GitHub App's name; GitHub app names are global, so include an owner or stage. */
  GITHUB_APP_NAME: z.string().default('slop-dev'),
  /** slop's generic catalog (`catalog/` in the repo). */
  CATALOG_DIR: z.string().default('../../catalog'),
  /** The Cognito app client Claude Code uses; filled into the agent set's `.mcp.json`. */
  CLAUDE_CODE_CLIENT_ID: z.string().default(''),
  /** Signs short-lived download links (agent-set bundles). Random per process if unset. */
  SIGNING_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const config = schema.parse(env);
  if (config.AUTH_MODE === 'cognito') {
    for (const key of ['COGNITO_USER_POOL_ID', 'COGNITO_REGION', 'COGNITO_DOMAIN', 'COGNITO_CLIENT_IDS'] as const) {
      if (config[key] === undefined) throw new Error(`${key} is required when AUTH_MODE=cognito`);
    }
  }
  return config;
};
