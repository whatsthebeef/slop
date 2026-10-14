import { createHash } from 'node:crypto';
import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { AtfIntegration } from '@slop/core';

/** What a push-mode ATF start needs: where, at which commit, and what to run (empty: the board's default suite). */
export interface AtfStart {
  readonly boardId: number;
  readonly integration: AtfIntegration;
  readonly environment: string;
  readonly sha: string;
  /** Repo-relative spec paths, one per line in `SLOP_ATF_SPECS`. */
  readonly specs: readonly string[];
  /** Playwright `--grep` patterns of the batch; combined into one alternation in `SLOP_ATF_GREP`. */
  readonly greps: readonly string[];
}

export interface StartedAtf {
  readonly buildId: string;
  readonly url: string | null;
}

/** Starts a board's ATF project. Slop creates nothing in AWS: a person sets the project (and role) up. */
export interface AtfStarter {
  start(job: AtfStart): Promise<StartedAtf>;
}

/** One pattern as it is; several as an alternation, so the build runs the union of the globs' tests. */
export const combineGreps = (greps: readonly string[]): string => {
  const unique = [...new Set(greps)];
  return unique.length <= 1 ? (unique[0] ?? '') : unique.map((g) => `(?:${g})`).join('|');
};

/** The environment variables the ATF build gets (what `catalog/scripts/atf-specs.sh` also exports in pull mode). */
export const atfVariables = (job: AtfStart): Record<string, string> => ({
  SLOP_ATF_SPECS: job.specs.join('\n'),
  SLOP_ATF_GREP: combineGreps(job.greps),
  SLOP_ENVIRONMENT: job.environment,
  SLOP_SHA: job.sha,
});

/** A start of the same deploy repeats with the same token, so CodeBuild returns the build it already started. */
export const atfIdempotencyToken = (boardId: number, environment: string, sha: string): string =>
  createHash('sha256')
    .update(`atf\n${String(boardId)}\n${environment}\n${sha}`)
    .digest('hex');

/** Short-lived credentials from `AssumeRole`, in the shape the SDK's credential provider returns. */
export interface RoleCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
}

export type AssumeRole = (roleArn: string, region: string) => Promise<RoleCredentials>;

/** `sts:AssumeRole` with slop's own credentials; the session lasts the shortest time STS allows. */
export const assumeWithSts: AssumeRole = async (roleArn, region) => {
  const { Credentials: c } = await new STSClient({ region }).send(
    new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'slop-atf', DurationSeconds: 900 }),
    { abortSignal: AbortSignal.timeout(15_000) },
  );
  if (
    c?.AccessKeyId === undefined ||
    c.SecretAccessKey === undefined ||
    c.SessionToken === undefined ||
    c.Expiration === undefined
  ) {
    throw new Error(`STS returned no credentials for ${roleArn}`);
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration,
  };
};

/**
 * CodeBuild: `StartBuild` on the board's ATF project with the spec list in environment variable overrides, under the
 * board's `roleArn` when it names one (else slop's own credentials). Results come back the usual way: the build's own
 * `atf-report.sh`.
 */
export class CodeBuildAtfStarter implements AtfStarter {
  private readonly clients = new Map<string, CodeBuildClient>();

  constructor(private readonly assume: AssumeRole = assumeWithSts) {}

  async start(job: AtfStart): Promise<StartedAtf> {
    const { region, project } = job.integration;
    const { build } = await (
      await this.client(job.integration)
    ).send(
      new StartBuildCommand({
        projectName: project,
        idempotencyToken: atfIdempotencyToken(job.boardId, job.environment, job.sha),
        environmentVariablesOverride: Object.entries(atfVariables(job)).map(([name, value]) => ({
          name,
          value,
          type: 'PLAINTEXT',
        })),
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    if (build?.id === undefined) throw new Error(`CodeBuild returned no build for ${project}`);
    const url =
      `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/` +
      `${encodeURIComponent(project)}/build/${encodeURIComponent(build.id)}/?region=${region}`;
    return { buildId: build.id, url };
  }

  private async client({ region, roleArn }: AtfIntegration): Promise<CodeBuildClient> {
    // Role credentials expire, so a role's client is rebuilt for every start (starts are rare).
    if (roleArn !== undefined) {
      const credentials = await this.assume(roleArn, region);
      return new CodeBuildClient({ region, credentials });
    }
    let client = this.clients.get(region);
    if (client === undefined) {
      client = new CodeBuildClient({ region });
      this.clients.set(region, client);
    }
    return client;
  }
}
