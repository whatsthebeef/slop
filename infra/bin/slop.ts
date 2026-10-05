import { App } from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack.js';
import { DeployTargetStack } from '../lib/deploy-target-stack.js';

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

new AuthStack(app, `slop-${stage}-auth`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  stage,
  boardCallbackUrls: [
    ...csv('boardCallbackUrls', ['http://localhost:3000/auth/callback', 'http://localhost:5173/auth/callback']),
    ...extraOrigins.map((o) => `${o}/auth/callback`),
  ],
  boardLogoutUrls: [...csv('boardLogoutUrls', ['http://localhost:3000/', 'http://localhost:5173/']), ...extraOrigins.map((o) => `${o}/`)],
  claudeCodeCallbackUrls: csv('claudeCodeCallbackUrls', ['http://localhost:7779/callback']),
  cliCallbackUrls: csv('cliCallbackUrls', ['http://localhost:7780/callback']),
  identityCenterMetadataUrl: (app.node.tryGetContext('identityCenterMetadataUrl') as string | undefined) ?? null,
  tags: { project: 'slop', stage },
});

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
  } else if (deployTargetProjects !== undefined) {
    new DeployTargetStack(app, `slop-${stage}-deploy-${required('deployTargetName')}`, {
      env,
      target: { kind: 'existing', projectNames: deployTargetProjects.split(',').map((p) => p.trim()).filter((p) => p !== '') },
      webhookUrl: required('deployTargetWebhookUrl'),
      tags: { project: 'slop', stage },
    });
  }
}
