import { randomBytes } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { and, eq, gt } from 'drizzle-orm';
import type { Config } from './config.js';
import * as schema from './db/schema.js';
import type { Db } from './db/store.js';

const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'slop_session';

export interface Identity {
  readonly email: string;
  readonly name: string;
}

/** Turns credentials into a person. Users are created on first sign-in; roles live on board memberships. */
export class Auth {
  private readonly verifier: ReturnType<typeof CognitoJwtVerifier.create> | null;
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
      return await this.emailForAccessToken(payload.sub, token);
    } catch {
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
