import { chmod, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

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

/**
 * Holds the GitHub App's credentials. Locally they live in a gitignored file written by the
 * manifest flow; in production they come from Secrets Manager. They can be replaced at runtime,
 * so finishing the setup flow needs no restart.
 */
export class AppCredentialsStore {
  private current: AppCredentials | null = null;

  constructor(private readonly file: string) {}

  get(): AppCredentials | null {
    return this.current;
  }

  async load(): Promise<AppCredentials | null> {
    try {
      const parsed = appCredentialsSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
      this.current = parsed.success ? parsed.data : null;
    } catch {
      this.current = null;
    }
    return this.current;
  }

  async save(credentials: AppCredentials): Promise<void> {
    await writeFile(this.file, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    await chmod(this.file, 0o600);
    this.current = credentials;
  }
}
