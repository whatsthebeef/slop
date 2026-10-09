import { GetSecretValueCommand, PutSecretValueCommand, ResourceNotFoundException, CreateSecretCommand } from '@aws-sdk/client-secrets-manager';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Config } from './config.js';

/**
 * Where sensitive settings live. In production Secrets Manager (read through the instance role); locally
 * the gitignored files stay as they are (`.github-app.json`, `.routines.json`, `.env.cognito`), so the
 * local adapter is those files and this port is only used for what production keeps in Secrets Manager.
 */
export interface SecretStore {
  /** The secret's value, or null when it doesn't exist (or is still an empty placeholder). */
  get(name: string): Promise<string | null>;
  /** Creates or replaces the secret. */
  put(name: string, value: string): Promise<void>;
}

/** One secret that can be read and replaced: the GitHub App's credentials, locally a file and in production a secret. */
export interface SecretSlot {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export const storeSlot = (store: SecretStore, name: string): SecretSlot => ({
  read: () => store.get(name),
  write: (value) => store.put(name, value),
});

/** An in-memory store, for tests. */
export class MemorySecretStore implements SecretStore {
  constructor(private readonly values = new Map<string, string>()) {}

  get(name: string): Promise<string | null> {
    return Promise.resolve(this.values.get(name) ?? null);
  }

  put(name: string, value: string): Promise<void> {
    this.values.set(name, value);
    return Promise.resolve();
  }
}

/** Secrets Manager through the AWS SDK's default credential chain (the EC2 instance role in production). */
export class AwsSecretStore implements SecretStore {
  constructor(private readonly client: Pick<SecretsManagerClient, 'send'>) {}

  async get(name: string): Promise<string | null> {
    try {
      const result = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
      // The CDK placeholders are created empty; an unset secret reads as missing.
      return result.SecretString === undefined || result.SecretString === '' ? null : result.SecretString;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return null;
      throw new Error(`Secrets Manager: could not read ${name}: ${errorName(error)}`, { cause: error });
    }
  }

  async put(name: string, value: string): Promise<void> {
    try {
      await this.client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw new Error(`Secrets Manager: could not write ${name}: ${errorName(error)}`, { cause: error });
      try {
        await this.client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
      } catch (created) {
        throw new Error(`Secrets Manager: could not create ${name}: ${errorName(created)}`, { cause: created });
      }
    }
  }
}

// Only the error's name: SDK messages and requests can echo the secret's id but must never carry its value.
const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown error');

/** The secrets' names under the configured prefix (`slop/prod/`); one place so the CDK construct and the server agree. */
export const secretNames = (prefix: string) => ({
  signingSecret: `${prefix}signing-secret`,
  cognitoBoardClientSecret: `${prefix}cognito-board-client-secret`,
  slackSigningSecret: `${prefix}slack-signing-secret`,
  slackBotToken: `${prefix}slack-bot-token`,
  githubApp: `${prefix}github-app`,
  routinesPrefix: `${prefix}routines/`,
});

/** The secrets a server needs at start, with the setting each fills; `required` ones stop the start when missing. */
const startSecrets = (names: ReturnType<typeof secretNames>, config: Config) => [
  { name: names.signingSecret, key: 'SIGNING_SECRET', required: true },
  { name: names.cognitoBoardClientSecret, key: 'COGNITO_BOARD_CLIENT_SECRET', required: config.AUTH_MODE === 'cognito' },
  { name: names.slackSigningSecret, key: 'SLACK_SIGNING_SECRET', required: false },
  { name: names.slackBotToken, key: 'SLACK_BOT_TOKEN', required: false },
] as const;

/**
 * Fills the sensitive settings from the secret store when `SECRETS=aws`; otherwise returns the config as is.
 * Fails fast, naming the secret, when a required one is missing. Never logs a value.
 */
export const withSecrets = async (config: Config, store: SecretStore): Promise<Config> => {
  const names = secretNames(config.SECRETS_PREFIX);
  const found: Partial<Record<'SIGNING_SECRET' | 'COGNITO_BOARD_CLIENT_SECRET' | 'SLACK_SIGNING_SECRET' | 'SLACK_BOT_TOKEN', string>> = {};
  const missing: string[] = [];
  for (const secret of startSecrets(names, config)) {
    const value = await store.get(secret.name);
    if (value !== null) found[secret.key] = value.trim();
    else if (secret.required) missing.push(secret.name);
  }
  if (missing.length > 0) {
    throw new Error(`SECRETS=aws: missing secret${missing.length > 1 ? 's' : ''} in Secrets Manager: ${missing.join(', ')}`);
  }
  if ((found.SLACK_SIGNING_SECRET === undefined) !== (found.SLACK_BOT_TOKEN === undefined)) {
    throw new Error(`SECRETS=aws: set both ${names.slackSigningSecret} and ${names.slackBotToken}, or neither`);
  }
  return { ...config, ...found };
};
