import { App } from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack.js';
import { SlopSecrets } from '../lib/secrets.js';
import { Stack } from 'aws-cdk-lib';
import { DeployTargetStack } from '../lib/deploy-target-stack.js';
import { HostStack } from '../lib/host-stack.js';

const app = new App();
const stage = String(app.node.tryGetContext('stage') ?? 'dev');
const csv = (key: string, fallback: string[]): string[] => {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter((s) => s !== '') : fallback;
};

/** Extra board origins (e.g. a developer's tunnel), kept out of the repo: SLOP_EXTRA_ORIGINS=https://a,https://b */
const extraOrigins = (process.env.SLOP_EXTRA_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter((s) => s !== '');

/**
 * Production's sign-in addresses come from the public address (`-c publicUrl=https://<id>.cloudfront.net`, the host
 * stack's PublicUrl output) and never include localhost. Claude Code's and the CLI's loopback callbacks stay, since
 * those tools run on the developer's machine.
 */
const production = stage === 'prod';
const publicUrl = (app.node.tryGetContext('publicUrl') as string | undefined)?.replace(/\/$/, '');
if (production && (publicUrl === undefined || !publicUrl.startsWith('https://'))) {
  throw new Error('-c publicUrl=https://<production address> (the host stack\'s PublicUrl output) is required for -c stage=prod');
}
const origins = production && publicUrl !== undefined ? [publicUrl] : [];

new AuthStack(app, `slop-${stage}-auth`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  stage,
  boardCallbackUrls: production
    ? origins.map((o) => `${o}/auth/callback`)
    : [
        ...csv('boardCallbackUrls', ['http://localhost:3000/auth/callback', 'http://localhost:5173/auth/callback']),
        ...extraOrigins.map((o) => `${o}/auth/callback`),
      ],
  boardLogoutUrls: production
    ? origins.map((o) => `${o}/`)
    : [...csv('boardLogoutUrls', ['http://localhost:3000/', 'http://localhost:5173/']), ...extraOrigins.map((o) => `${o}/`)],
  claudeCodeCallbackUrls: csv('claudeCodeCallbackUrls', ['http://localhost:7779/callback']),
  cliCallbackUrls: csv('cliCallbackUrls', ['http://localhost:7780/callback']),
  identityCenterMetadataUrl: (app.node.tryGetContext('identityCenterMetadataUrl') as string | undefined) ?? null,
  tags: { project: 'slop', stage },
});

/**
 * Production's secrets (server `SECRETS=aws`) and host. The host reuses the secrets construct and grants its instance
 * role with `grantServer`, so asking for the host (`-c host=true`, or just giving it `deployConnectionArn`) also creates the secrets stack.
 * Other stacks (`slop-prod-auth`) synth without it.
 *   cdk deploy slop-prod-secrets -c secrets=true -c stage=prod                the secrets alone
 *   cdk deploy slop-prod-host -c stage=prod -c deployConnectionArn=arn:...    the host, CloudFront and the deploy project
 */
const flag = (key: string): boolean => app.node.tryGetContext(key) === 'true' || app.node.tryGetContext(key) === true;
const wantsHost = flag('host') || app.node.tryGetContext('deployConnectionArn') !== undefined;
if (flag('secrets') || wantsHost) {
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' };
  const secretsStack = new Stack(app, `slop-${stage}-secrets`, { env, tags: { project: 'slop', stage } });
  const secrets = new SlopSecrets(secretsStack, 'Secrets', { stage });
  if (wantsHost) {
    const connectionArn = app.node.tryGetContext('deployConnectionArn') as unknown;
    if (typeof connectionArn !== 'string' || connectionArn === '') {
      throw new Error('-c deployConnectionArn=arn:aws:codeconnections:... (a GitHub connection that can read the repo) is required for the host stack');
    }
    new HostStack(app, `slop-${stage}-host`, {
      env,
      stage,
      secrets,
      connectionArn,
      repo: (app.node.tryGetContext('hostRepo') as string | undefined) ?? 'whatsthebeef/slop',
      branch: (app.node.tryGetContext('hostBranch') as string | undefined) ?? 'main',
      // com.amazonaws.global.cloudfront.origin-facing in us-east-1; pass -c cloudFrontPrefixListId=pl-... elsewhere.
      cloudFrontPrefixListId: (app.node.tryGetContext('cloudFrontPrefixListId') as string | undefined) ?? 'pl-3b927c52',
      // Where the missing-backup alarm emails (-c alertEmail=you@example.com); confirm the subscription from the first message.
      alertEmail: (app.node.tryGetContext('alertEmail') as string | undefined) || undefined,
      tags: { project: 'slop', stage },
    });
  }
}

/**
 * A branch-deploy target for a board (e.g. a sandbox), only when its context is given. Either a new
 * CodeBuild project running the repo's `.sstor/deploy.sh`:
 *   cdk deploy -c deployTargetRepo=owner/name -c deployTargetConnectionArn=arn:... \
 *     -c deployTargetWebhookUrl=https://<public slop>/webhooks/aws [-c deployTargetName=<project>]
 * or existing deploy projects, whose builds are only reported to slop:
 *   cdk deploy -c deployTargetProjects=<project>,<project> -c deployTargetName=<name> \
 *     -c deployTargetWebhookUrl=https://<public slop>/webhooks/aws
 */
const contextValue = (key: string): string | undefined => {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === 'string' && value !== '' ? value : undefined;
};
const required = (key: string): string => {
  const value = contextValue(key);
  if (value === undefined) throw new Error(`-c ${key}=... is required for a deploy target`);
  return value;
};
const deployTargetRepo = contextValue('deployTargetRepo');
const deployTargetProjects = contextValue('deployTargetProjects');
if (deployTargetRepo !== undefined && deployTargetProjects !== undefined) {
  throw new Error('Pass deployTargetRepo (a new project) or deployTargetProjects (existing projects), not both');
}
if (deployTargetRepo !== undefined || deployTargetProjects !== undefined) {
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' };
  if (deployTargetRepo !== undefined) {
    const name = contextValue('deployTargetName') ?? `${deployTargetRepo.split('/').at(-1) ?? 'app'}-deploy`;
    new DeployTargetStack(app, `slop-${stage}-deploy-${name}`, {
      env,
      target: { kind: 'new', repo: deployTargetRepo, connectionArn: required('deployTargetConnectionArn'), projectName: name },
      webhookUrl: required('deployTargetWebhookUrl'),
      tags: { project: 'slop', stage },
    });
  } else {
    new DeployTargetStack(app, `slop-${stage}-deploy-${required('deployTargetName')}`, {
      env,
      target: { kind: 'existing', projectNames: (deployTargetProjects ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '') },
      webhookUrl: required('deployTargetWebhookUrl'),
      tags: { project: 'slop', stage },
    });
  }
}
