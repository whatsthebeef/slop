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
  /** App client IDs whose access tokens slop accepts (board, Claude connector, Claude Code and the slop CLI). */
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
  /**
   * Accept a signed board sign-in state without its nonce cookie on a plain-http localhost origin
   * (Chrome drops the cookie there on the return from Cognito). Off unless a dev server turns it on,
   * so a proxy that rewrites Host to localhost can't open login CSRF elsewhere.
   */
  LOCAL_SIGN_IN_WITHOUT_COOKIE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Signs short-lived download links (agent-set bundles). Random per process if unset. */
  SIGNING_SECRET: z.string().optional(),
  /** Each developer's routine fire URL and token, keyed by email (gitignored; Secrets Manager in production). */
  ROUTINES_FILE: z.string().default('.routines.json'),
  /**
   * Where deploy jobs post their results (`/webhooks/deploy/...`): a URL CodeBuild or GitHub can
   * reach. Defaults to PUBLIC_URL; locally, the ngrok tunnel.
   */
  WEBHOOK_BASE_URL: z.string().optional(),
  /**
   * The keys EventBridge API destinations send to `/webhooks/aws` (CodeBuild results), comma-separated:
   * each deploy-target stack generates its own. Off when unset.
   */
  AWS_WEBHOOK_KEY: z
    .string()
    .optional()
    .transform((v) => (v ?? '').split(',').map((k) => k.trim()).filter((k) => k !== '')),
  /** The ngrok domain of the local webhook tunnel (set by scripts/dev.sh); the board warns when it isn't up. */
  SLOP_TUNNEL_DOMAIN: z.string().optional(),
  BEDROCK_REGION: z.string().default('us-east-1'),
  /** Haiku 4.5 for intake and classification. */
  INTAKE_MODEL: z.string().default('us.anthropic.claude-haiku-4-5-20251001-v1:0'),
  /**
   * Opus 5.5 (US cross-region inference profile) routes and deduplicates submitted KB items: the KB
   * pipeline is the most important part of the system. Override in apps/server/.env.local if Bedrock
   * names it differently.
   */
  KB_ROUTE_MODEL: z.string().default('us.anthropic.claude-opus-5-5'),
  /** Opus 5.5 (US cross-region inference profile) drafts KB changes. */
  KB_DRAFT_MODEL: z.string().default('us.anthropic.claude-opus-5-5'),
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
