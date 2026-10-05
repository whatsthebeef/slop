import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import type { Board, Deploy, DeployIntegration } from '@slop/core';

/** What a deploy job needs: the commit, where it goes, and how to report back. */
export interface DeployJob {
  readonly board: Board;
  readonly deploy: Deploy;
  /** The glob's branch; the job checks out `deploy.sha` exactly, never the moving branch. */
  readonly branch: string;
  /** A signed URL the job's `.sstor/deploy.sh` may POST its result to (works for any provider). */
  readonly callbackUrl: string;
}

/** The provider's handle on a started deploy, matched later against its result events. */
export interface StartedDeploy {
  readonly providerRef: string;
  readonly url: string | null;
}

/**
 * Starts branch deploys. Deploy scripts never run on slop's server: an adapter starts the board's
 * provider job, which runs the repo's `.sstor/deploy.sh <env>` at exactly the deploy's commit.
 */
export interface Deployer {
  start(job: DeployJob): Promise<StartedDeploy>;
}

/** Environment variables every provider passes to `.sstor/deploy.sh`. */
export const deployVariables = (job: DeployJob): Record<string, string> => ({
  SLOP_ENVIRONMENT: job.deploy.environment,
  SLOP_GLOB: job.deploy.globId,
  SLOP_SHA: job.deploy.sha,
  SLOP_DEPLOY_ID: job.deploy.id,
  SLOP_CALLBACK_URL: job.callbackUrl,
});

type CodeBuildIntegration = Extract<DeployIntegration, { provider: 'codebuild' }>;

/**
 * CodeBuild: `StartBuild` on the environment's project (or the board default) with the commit as
 * the source version. Results arrive through EventBridge (`/webhooks/aws`), matched by build ARN.
 * Credentials come from slop's IAM role (or the developer's AWS profile locally).
 */
export class CodeBuildDeployer implements Deployer {
  private readonly clients = new Map<string, CodeBuildClient>();

  async start(job: DeployJob): Promise<StartedDeploy> {
    const integration = job.board.deploy;
    if (integration?.provider !== 'codebuild') throw new Error(`Board ${job.board.id} doesn't deploy with CodeBuild`);
    const projectName = projectFor(integration, job.deploy.environment);
    const { build } = await this.client(integration.region).send(
      new StartBuildCommand({
        projectName,
        sourceVersion: job.deploy.sha,
        // A retried start returns the same build rather than starting another.
        idempotencyToken: job.deploy.id,
        environmentVariablesOverride: Object.entries(deployVariables(job)).map(([name, value]) => ({
          name,
          value,
          type: 'PLAINTEXT',
        })),
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    if (build?.arn === undefined || build.id === undefined) throw new Error(`CodeBuild returned no build for ${projectName}`);
    const url =
      `https://${integration.region}.console.aws.amazon.com/codesuite/codebuild/projects/` +
      `${encodeURIComponent(projectName)}/build/${encodeURIComponent(build.id)}/?region=${integration.region}`;
    return { providerRef: build.arn, url };
  }

  private client(region: string): CodeBuildClient {
    let client = this.clients.get(region);
    if (client === undefined) {
      client = new CodeBuildClient({ region });
      this.clients.set(region, client);
    }
    return client;
  }
}

export const projectFor = (integration: CodeBuildIntegration, environment: string): string =>
  integration.projects[environment] ?? integration.defaultProject;

/** Picks the adapter for the board's integration. */
export class Deployers implements Deployer {
  constructor(private readonly byProvider: Partial<Record<DeployIntegration['provider'], Deployer>>) {}

  start(job: DeployJob): Promise<StartedDeploy> {
    const provider = job.board.deploy?.provider;
    const deployer = provider === undefined ? undefined : this.byProvider[provider];
    if (deployer === undefined) {
      return Promise.reject(new Error(`No deployer for ${provider ?? 'boards without a deploy integration'} yet`));
    }
    return deployer.start(job);
  }
}
