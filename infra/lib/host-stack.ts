import { readFileSync } from 'node:fs';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BuildSpec, CfnProject, ComputeType, EventAction, FilterGroup, LinuxArmBuildImage, Project, Source } from 'aws-cdk-lib/aws-codebuild';
import {
  BlockDeviceVolume,
  CfnInstance,
  EbsDeviceVolumeType,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  MachineImage,
  AmazonLinuxCpuType,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  UserData,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Repository, TagStatus } from 'aws-cdk-lib/aws-ecr';
import { ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { SlopSecrets } from './secrets.js';

export interface HostStackProps extends StackProps {
  /** `prod`; names the stack, the parameters and the secrets prefix. */
  readonly stage: string;
  /** The Secrets Manager secrets the server reads (`slop-<stage>-secrets`); the instance role may read them. */
  readonly secrets: SlopSecrets;
  /** An AWS CodeConnections connection to GitHub that can read the repository. */
  readonly connectionArn: string;
  /** The repository, as owner/name. */
  readonly repo: string;
  /** The branch whose pushes are deployed. */
  readonly branch: string;
  /**
   * CloudFront's origin-facing managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`). Its ID differs per
   * region (us-east-1 is the default); look it up with `aws ec2 describe-managed-prefix-lists`.
   */
  readonly cloudFrontPrefixListId: string;
}

const APP_PORT = 3000;

/**
 * Production's host: slop and Postgres under Docker Compose on one small Graviton instance, served over HTTPS at a
 * CloudFront address, and deployed by CodeBuild on every push to the branch (`infra/deploy/`).
 *
 *   viewer ──https──▶ CloudFront ──http :3000──▶ EC2 (security group: CloudFront's prefix list only)
 *   push to main ──▶ CodeBuild: checks, arm64 image ──▶ ECR ──▶ SSM Run Command ──▶ pull, compose up, health, rollback
 *
 * The instance has no key pair and no port 22; access is SSM Session Manager. Its role reads the server's secrets,
 * pulls from ECR, calls Bedrock, and reads the `/slop/<stage>/*` parameters (`server-env` holds the settings that
 * change by hand, e.g. s15f34's Cognito pool).
 *
 * The CloudFront address is only known once the distribution exists and the distribution's origin is the instance,
 * so the instance never learns it from the stack: CodeBuild passes it to each deploy as `PUBLIC_URL`.
 */
export class HostStack extends Stack {
  constructor(scope: Construct, id: string, props: HostStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const retain = stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const repository = new Repository(this, 'Repository', {
      repositoryName: 'slop',
      imageScanOnPush: true,
      removalPolicy: retain,
      emptyOnDelete: stage !== 'prod',
      lifecycleRules: [{ description: 'Keep the 30 most recent images', tagStatus: TagStatus.ANY, maxImageCount: 30 }],
    });

    // The deploy files for each release (compose file, deploy script): CodeBuild writes them, the instance reads them.
    const artifacts = new Bucket(this, 'DeployFiles', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });

    const vpc = Vpc.fromLookup(this, 'Vpc', { isDefault: true });
    const securityGroup = new SecurityGroup(this, 'HostSecurityGroup', {
      vpc,
      description: 'slop host: the app port from CloudFront only; no SSH',
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(Peer.prefixList(props.cloudFrontPrefixListId), Port.tcp(APP_PORT), 'CloudFront origin-facing');

    const role = new Role(this, 'HostRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      description: 'slop host: SSM, ECR pull, Secrets Manager, Bedrock, deploy files',
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    repository.grantPull(role);
    artifacts.grantRead(role);
    props.secrets.grantServer(role);
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `slop/${stage}/*` })],
      }),
    );
    // The models slop calls are US cross-region inference profiles, which Bedrock serves from several regions.
    role.addToPolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['arn:aws:bedrock:*::foundation-model/*', `arn:aws:bedrock:*:${this.account}:inference-profile/*`],
      }),
    );
    // Backups (s15f33) add their own bucket grant.

    const instance = new Instance(this, 'Host', {
      vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.SMALL),
      machineImage: MachineImage.latestAmazonLinux2023({ cpuType: AmazonLinuxCpuType.ARM_64 }),
      securityGroup,
      role,
      requireImdsv2: true,
      blockDevices: [
        { deviceName: '/dev/xvda', volume: BlockDeviceVolume.ebs(30, { volumeType: EbsDeviceVolumeType.GP3, encrypted: true }) },
        // Postgres' data: kept when the instance is replaced or deleted (s15f33 snapshots it).
        {
          deviceName: '/dev/sdf',
          volume: BlockDeviceVolume.ebs(30, { volumeType: EbsDeviceVolumeType.GP3, encrypted: true, deleteOnTermination: false }),
        },
      ],
      userData: UserData.custom(readFileSync(new URL('../deploy/instance-setup.sh', import.meta.url), 'utf8')),
      userDataCausesReplacement: false,
    });
    // Containers reach the instance role's credentials through the metadata service, one hop further than the host.
    const cfnInstance = instance.node.defaultChild;
    if (!(cfnInstance instanceof CfnInstance)) throw new Error('Expected the EC2 instance resource');
    cfnInstance.addPropertyOverride('MetadataOptions.HttpPutResponseHopLimit', 2);

    const origin = new HttpOrigin(instance.instancePublicDnsName, {
      protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
      httpPort: APP_PORT,
      // The board stream sends a keep-alive every 25 s, so a read timeout above that keeps it open.
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(60),
    });
    const distribution = new Distribution(this, 'Distribution', {
      comment: `slop ${stage}`,
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        // The API, sign-in, MCP, SSE, webhooks and well-known documents are all dynamic: nothing is cached unless a
        // behaviour below says so. Everything is forwarded (Host, Authorization, cookies, CloudFront-Forwarded-Proto)
        // so slop builds its URLs from the address the viewer used.
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022,
        // A text/event-stream response must not be buffered for compression.
        compress: false,
      },
      additionalBehaviors: {
        // The built board's hashed bundles.
        '/assets/*': {
          origin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
      },
    });
    const publicUrl = `https://${distribution.distributionDomainName}`;

    const [owner, repo] = props.repo.split('/');
    if (owner === undefined || repo === undefined) throw new Error(`repo must be owner/name, not ${props.repo}`);
    // CodeBuild checks the role can use the connection when it creates the project, so the permission is in the role from the start.
    const buildRole = new Role(this, 'DeployRole', {
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
    repository.grantPullPush(buildRole);
    artifacts.grantReadWrite(buildRole);
    buildRole.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [
          this.formatArn({ service: 'ssm', resource: 'document', resourceName: 'AWS-RunShellScript', account: '' }),
          this.formatArn({ service: 'ec2', resource: 'instance', resourceName: instance.instanceId }),
        ],
      }),
    );
    buildRole.addToPolicy(new PolicyStatement({ actions: ['ssm:GetCommandInvocation'], resources: ['*'] }));

    const project = new Project(this, 'Deploy', {
      projectName: `slop-${stage}-host-deploy`,
      role: buildRole,
      source: Source.gitHub({
        owner,
        repo,
        reportBuildStatus: false,
        webhook: true,
        webhookFilters: [FilterGroup.inEventOf(EventAction.PUSH).andBranchIs(props.branch)],
      }),
      buildSpec: BuildSpec.fromSourceFilename('infra/deploy/buildspec.yml'),
      environment: {
        buildImage: LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: ComputeType.MEDIUM,
        privileged: true,
      },
      environmentVariables: {
        AWS_REGION: { value: this.region },
        STAGE: { value: stage },
        INSTANCE_ID: { value: instance.instanceId },
        BUCKET: { value: artifacts.bucketName },
        REPOSITORY_URI: { value: repository.repositoryUri },
        PUBLIC_URL: { value: publicUrl },
      },
      timeout: Duration.minutes(30),
    });
    const cfnProject = project.node.defaultChild;
    if (!(cfnProject instanceof CfnProject)) throw new Error('Expected the CodeBuild project resource');
    cfnProject.addPropertyOverride('Source.Auth', { Type: 'CODECONNECTIONS', Resource: props.connectionArn });

    new CfnOutput(this, 'PublicUrl', { value: publicUrl, description: "slop's address (the server's PUBLIC_URL)" });
    new CfnOutput(this, 'InstanceId', { value: instance.instanceId, description: 'Open a shell with aws ssm start-session --target <id>' });
    new CfnOutput(this, 'RepositoryUri', { value: repository.repositoryUri });
    new CfnOutput(this, 'DeployProject', { value: project.projectName, description: 'First deploy: aws codebuild start-build --project-name <name>' });
    new CfnOutput(this, 'ServerEnvParameter', {
      value: `/slop/${stage}/server-env`,
      description: 'SSM parameter (String, KEY=VALUE per line) read at each deploy: AUTH_MODE and the COGNITO_* settings',
    });
  }
}
