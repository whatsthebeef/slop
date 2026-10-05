import { CfnOutput, Duration, SecretValue, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { BuildSpec, CfnProject, ComputeType, LinuxBuildImage, Project, Source } from 'aws-cdk-lib/aws-codebuild';
import { ApiDestination, Authorization, Connection, HttpMethod, Rule } from 'aws-cdk-lib/aws-events';
import { ApiDestination as ApiDestinationTarget } from 'aws-cdk-lib/aws-events-targets';
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export interface DeployTargetStackProps extends StackProps {
  /** The repository whose `.sstor/deploy.sh` the project runs, as owner/name. */
  readonly repo: string;
  /** An AWS CodeConnections connection to GitHub that can read the repository. */
  readonly connectionArn: string;
  /** Where slop receives CodeBuild results, e.g. https://<tunnel>/webhooks/aws. */
  readonly webhookUrl: string;
  /** The CodeBuild project's name (the board's default project in slop's settings). */
  readonly projectName: string;
}

/**
 * A branch-deploy target for a slop board: a CodeBuild project that runs the repository's
 * `.sstor/deploy.sh <env>` at the commit slop asks for (StartBuild with a source version), and an
 * EventBridge rule that sends the project's build results to slop through an API destination,
 * authenticated with a generated key (copy it into slop's AWS_WEBHOOK_KEY).
 */
export class DeployTargetStack extends Stack {
  constructor(scope: Construct, id: string, props: DeployTargetStackProps) {
    super(scope, id, props);
    const [owner, repo] = props.repo.split('/');
    if (owner === undefined || repo === undefined) throw new Error(`repo must be owner/name, not ${props.repo}`);

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
              resources: [props.connectionArn],
            }),
          ],
        }),
      },
    });
    const project = new Project(this, 'Deploy', {
      projectName: props.projectName,
      role,
      source: Source.gitHub({ owner, repo, reportBuildStatus: false }),
      buildSpec: BuildSpec.fromSourceFilename('.sstor/buildspec-deploy.yml'),
      environment: { buildImage: LinuxBuildImage.STANDARD_7_0, computeType: ComputeType.SMALL },
      timeout: Duration.minutes(30),
    });
    // Source access through the CodeConnections connection rather than account-wide GitHub credentials.
    const cfn = project.node.defaultChild;
    if (!(cfn instanceof CfnProject)) throw new Error('Expected the CodeBuild project resource');
    cfn.addPropertyOverride('Source.Auth', { Type: 'CODECONNECTIONS', Resource: props.connectionArn });

    const key = new Secret(this, 'WebhookKey', {
      description: `Key EventBridge sends to slop's /webhooks/aws for ${props.projectName}`,
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    const connection = new Connection(this, 'SlopConnection', {
      authorization: Authorization.apiKey('x-slop-key', SecretValue.secretsManager(key.secretArn)),
      description: 'slop webhooks',
    });
    const destination = new ApiDestination(this, 'SlopWebhook', {
      connection,
      endpoint: props.webhookUrl,
      httpMethod: HttpMethod.POST,
      rateLimitPerSecond: 5,
    });
    new Rule(this, 'BuildResults', {
      description: `${props.projectName} build state changes to slop`,
      eventPattern: {
        source: ['aws.codebuild'],
        detailType: ['CodeBuild Build State Change'],
        detail: { 'project-name': [props.projectName] },
      },
      targets: [new ApiDestinationTarget(destination)],
    });

    new CfnOutput(this, 'ProjectName', { value: project.projectName });
    new CfnOutput(this, 'WebhookKeySecretArn', { value: key.secretArn });
  }
}
