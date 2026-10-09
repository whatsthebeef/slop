import { chmod, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { SecretSlot } from '../secrets.js';

/** What GitHub returns when a GitHub App is created from a manifest. */
export const appCredentialsSchema = z.object({
  id: z.number(),
  slug: z.string(),
  pem: z.string(),
  webhook_secret: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
  html_url: z.string(),
});

export type AppCredentials = z.infer<typeof appCredentialsSchema>;

/** The local gitignored file, as a slot. */
export const fileSlot = (file: string): SecretSlot => ({
  read: async () => {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  },
  write: async (value) => {
    await writeFile(file, value, { mode: 0o600 });
    await chmod(file, 0o600);
  },
});

/**
 * Holds the GitHub App's credentials. Locally they live in a gitignored file written by the
 * manifest flow; in production in Secrets Manager (`SECRETS=aws`). They can be replaced at runtime,
 * so finishing the setup flow needs no restart.
 */
export class AppCredentialsStore {
  private current: AppCredentials | null = null;

  constructor(private readonly slot: SecretSlot) {}

  get(): AppCredentials | null {
    return this.current;
  }

  async load(): Promise<AppCredentials | null> {
    const raw = await this.slot.read();
    try {
      const parsed = raw === null ? null : appCredentialsSchema.safeParse(JSON.parse(raw));
      this.current = parsed?.success === true ? parsed.data : null;
    } catch {
      this.current = null;
    }
    return this.current;
  }

  async save(credentials: AppCredentials): Promise<void> {
    await this.slot.write(JSON.stringify(credentials, null, 2));
    this.current = credentials;
  }
}
