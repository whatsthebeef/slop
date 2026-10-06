import { CfnOutput, Duration, SecretValue, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { BuildSpec, CfnProject, ComputeType, LinuxBuildImage, Project, Source } from 'aws-cdk-lib/aws-codebuild';
import { ApiDestination, Authorization, Connection, HttpMethod, Rule } from 'aws-cdk-lib/aws-events';
import { ApiDestination as ApiDestinationTarget } from 'aws-cdk-lib/aws-events-targets';
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

/** A CodeBuild project the stack creates to run the repository's `.sstor/deploy.sh`. */
export interface NewDeployProject {
  readonly kind: 'new';
  /** The repository, as owner/name. */
  readonly repo: string;
  /** An AWS CodeConnections connection to GitHub that can read the repository. */
  readonly connectionArn: string;
  /** The project's name (the board's default project in slop's settings). */
  readonly projectName: string;
}

/** CodeBuild projects that already deploy the board's environments; the stack only reports their builds. */
export interface ExistingDeployProjects {
  readonly kind: 'existing';
  readonly projectNames: readonly string[];
}

export interface DeployTargetStackProps extends StackProps {
  readonly target: NewDeployProject | ExistingDeployProjects;
  /** Where slop receives CodeBuild results, e.g. https://<tunnel>/webhooks/aws. */
  readonly webhookUrl: string;
}

/**
 * A branch-deploy target for a slop board: an EventBridge rule that sends the deploy projects' build
 * results to slop through an API destination, authenticated with a generated key (add it to slop's
 * AWS_WEBHOOK_KEY list). With a new target it also creates the CodeBuild project, which runs the
 * repository's `.sstor/deploy.sh <env>` at the commit slop asks for; with existing projects (which
 * already deploy, e.g. from their own buildspec) it only reports their builds.
 */
export class DeployTargetStack extends Stack {
  constructor(scope: Construct, id: string, props: DeployTargetStackProps) {
    super(scope, id, props);
    const projectNames =
      props.target.kind === 'new' ? [this.createProject(props.target)] : [...props.target.projectNames];
    if (projectNames.length === 0) throw new Error('A deploy target needs at least one CodeBuild project');
    this.reportBuilds(projectNames, props.webhookUrl);
    // A new-project stack keeps the output name it was first deployed with.
    new CfnOutput(this, props.target.kind === 'new' ? 'ProjectName' : 'ProjectNames', { value: projectNames.join(',') });
  }

  /** The CodeBuild project that runs `.sstor/deploy.sh`; returns its name. */
  private createProject(target: NewDeployProject): string {
    const [owner, repo] = target.repo.split('/');
    if (owner === undefined || repo === undefined) throw new Error(`repo must be owner/name, not ${target.repo}`);

    // CodeBuild checks the project's role can use the connection when it creates the project, so the
    // role carries that permission from the start (an inline policy, created with the role and
    // before the project). Connections answer to both service prefixes.
    const role = new Role(this, 'DeployRole', {
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
      inlinePolicies: {
        Connection: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: [
                'codeconnections:UseConnection',
                'codeconnections:GetConnection',
                'codeconnections:GetConnectionToken',
                'codestar-connections:UseConnection',
                'codestar-connections:GetConnection',
                'codestar-connections:GetConnectionToken',
              ],
              resources: [target.connectionArn],
            }),
          ],
        }),
      },
    });
    const project = new Project(this, 'Deploy', {
      projectName: target.projectName,
      role,
      source: Source.gitHub({ owner, repo, reportBuildStatus: false }),
      buildSpec: BuildSpec.fromSourceFilename('.sstor/buildspec-deploy.yml'),
      environment: { buildImage: LinuxBuildImage.STANDARD_7_0, computeType: ComputeType.SMALL },
      timeout: Duration.minutes(30),
    });
    // Source access through the CodeConnections connection rather than account-wide GitHub credentials.
    const cfn = project.node.defaultChild;
    if (!(cfn instanceof CfnProject)) throw new Error('Expected the CodeBuild project resource');
    cfn.addPropertyOverride('Source.Auth', { Type: 'CODECONNECTIONS', Resource: target.connectionArn });
    return target.projectName;
  }

  /** Sends the projects' build state changes to slop's `/webhooks/aws`. */
  private reportBuilds(projectNames: readonly string[], webhookUrl: string): void {
    const key = new Secret(this, 'WebhookKey', {
      description: `Key EventBridge sends to slop's /webhooks/aws for ${projectNames.join(', ')}`.slice(0, 500),
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    const connection = new Connection(this, 'SlopConnection', {
      authorization: Authorization.apiKey('x-slop-key', SecretValue.secretsManager(key.secretArn)),
      description: 'slop webhooks',
    });
    const destination = new ApiDestination(this, 'SlopWebhook', {
      connection,
      endpoint: webhookUrl,
      httpMethod: HttpMethod.POST,
      rateLimitPerSecond: 5,
    });
    new Rule(this, 'BuildResults', {
      // EventBridge caps descriptions at 512 characters, so long project lists are cut short.
      description: `${projectNames.join(', ')} build state changes to slop`.slice(0, 500),
      eventPattern: {
        source: ['aws.codebuild'],
        detailType: ['CodeBuild Build State Change'],
        detail: { 'project-name': [...projectNames] },
      },
      targets: [new ApiDestinationTarget(destination)],
    });

    new CfnOutput(this, 'WebhookKeySecretArn', { value: key.secretArn });
  }
}
