import { randomBytes } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { and, eq, gt } from 'drizzle-orm';
import type { Config } from './config.js';
import * as schema from './db/schema.js';
import type { Db } from './db/store.js';

export const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'slop_session';

export interface Identity {
  readonly email: string;
  readonly name: string;
}

/** Turns credentials into a person. Users are created on first sign-in; roles live on board memberships. */
export class Auth {
  private readonly verifier: ReturnType<typeof CognitoJwtVerifier.create> | null;
  private readonly idVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null;
  private readonly emailBySub = new Map<string, string>();

  constructor(
    private readonly db: Db,
    readonly config: Config,
  ) {
    this.verifier =
      config.AUTH_MODE === 'cognito' && config.COGNITO_USER_POOL_ID !== undefined
        ? CognitoJwtVerifier.create({
            userPoolId: config.COGNITO_USER_POOL_ID,
            tokenUse: 'access',
            clientId: (config.COGNITO_CLIENT_IDS ?? '').split(',').map((s) => s.trim()),
          })
        : null;
    this.idVerifier =
      config.AUTH_MODE === 'cognito' &&
      config.COGNITO_USER_POOL_ID !== undefined &&
      config.COGNITO_BOARD_CLIENT_ID !== undefined
        ? CognitoJwtVerifier.create({
            userPoolId: config.COGNITO_USER_POOL_ID,
            tokenUse: 'id',
            clientId: config.COGNITO_BOARD_CLIENT_ID,
          })
        : null;
  }

  // ---------------------------------------------------------------------------
  // Board sign-in through Cognito's hosted UI (authorization code flow)

  /**
   * The callback on the origin the person signed in from: the public URL, or localhost during
   * development. Anything else falls back to the public URL. Each must be a Cognito callback URL.
   */
  boardRedirectUri(origin: string): string {
    return `${origin}/auth/callback`;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.COGNITO_BOARD_CLIENT_ID ?? '',
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
    });
    return `https://${this.config.COGNITO_DOMAIN ?? ''}/oauth2/authorize?${params.toString()}`;
  }

  /** Exchanges the authorization code and returns the verified person, or null. */
  async completeSignIn(code: string, redirectUri: string): Promise<Identity | null> {
    if (this.idVerifier === null) return null;
    const { COGNITO_BOARD_CLIENT_ID: id = '', COGNITO_BOARD_CLIENT_SECRET: secret = '' } = this.config;
    const response = await fetch(`https://${this.config.COGNITO_DOMAIN ?? ''}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
    if (!response.ok) {
      // Cognito's error code only (e.g. invalid_grant, invalid_client); the body carries no tokens on failure.
      const error = await response.text().then((t) => /"error"\s*:\s*"([^"]+)"/.exec(t)?.[1] ?? 'unknown', () => 'unreadable');
      console.warn(`[auth] board sign-in: token exchange failed (${response.status} ${error}) for ${redirectUri}`);
      return null;
    }
    const tokens = (await response.json()) as { id_token?: unknown };
    if (typeof tokens.id_token !== 'string') {
      console.warn('[auth] board sign-in: token response had no id_token');
      return null;
    }
    try {
      const claims = await this.idVerifier.verify(tokens.id_token);
      if (typeof claims.email !== 'string') {
        console.warn('[auth] board sign-in: ID token has no email claim');
        return null;
      }
      const email = claims.email.toLowerCase();
      const name = typeof claims.name === 'string' ? claims.name : email;
      await this.ensureUser({ email, name }, claims.sub);
      return { email, name };
    } catch (error) {
      console.warn(`[auth] board sign-in: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Board sessions (server-side, behind an HttpOnly cookie)

  async createSession(identity: Identity): Promise<string> {
    await this.ensureUser(identity);
    const id = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await this.db.insert(schema.sessions).values({ id, email: identity.email, expiresAt });
    return id;
  }

  async sessionEmail(id: string): Promise<string | null> {
    const [row] = await this.db
      .select({ email: schema.sessions.email, active: schema.users.active })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.email, schema.sessions.email))
      .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, new Date())));
    return row?.active === true ? row.email : null;
  }

  async endSession(id: string): Promise<void> {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.id, id));
  }

  // ---------------------------------------------------------------------------
  // Bearer tokens (MCP and REST clients)

  /** Returns the person a bearer token acts as, or null if it is not valid. */
  async bearerEmail(token: string): Promise<string | null> {
    if (this.config.AUTH_MODE === 'dev') {
      if (!token.startsWith('dev:')) return null;
      const email = token.slice(4).trim().toLowerCase();
      if (!email.includes('@')) return null;
      await this.ensureUser({ email, name: email });
      return email;
    }
    if (this.verifier === null) return null;
    try {
      const payload = await this.verifier.verify(token);
      const email = await this.emailForAccessToken(payload.sub, token);
      if (email === null) console.warn(`[auth] no email for access token of ${payload.sub}`);
      return email;
    } catch (error) {
      console.warn(`[auth] rejected bearer token: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** Access tokens carry no email, so look it up once per subject through Cognito's userInfo endpoint. */
  private async emailForAccessToken(sub: string, token: string): Promise<string | null> {
    const cached = this.emailBySub.get(sub);
    if (cached !== undefined) return cached;
    const [known] = await this.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.cognitoSub, sub));
    let email = known?.email ?? null;
    if (email === null) {
      const response = await fetch(`https://${this.config.COGNITO_DOMAIN ?? ''}/oauth2/userInfo`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      const info = (await response.json()) as { email?: unknown; name?: unknown };
      if (typeof info.email !== 'string') return null;
      email = info.email.toLowerCase();
      await this.ensureUser({ email, name: typeof info.name === 'string' ? info.name : email }, sub);
    }
    this.emailBySub.set(sub, email);
    return email;
  }

  // ---------------------------------------------------------------------------

  private async ensureUser(identity: Identity, cognitoSub: string | null = null): Promise<void> {
    await this.db
      .insert(schema.users)
      .values({ email: identity.email, name: identity.name, cognitoSub })
      .onConflictDoUpdate({
        target: schema.users.email,
        set: cognitoSub === null ? { name: identity.name } : { name: identity.name, cognitoSub },
      });
  }
}
