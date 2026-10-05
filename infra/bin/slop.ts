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
 * A branch-deploy target for a board (e.g. a sandbox), only when its context is given:
 *   cdk deploy -c deployTargetRepo=owner/name -c deployTargetConnectionArn=arn:... \
 *     -c deployTargetWebhookUrl=https://<public slop>/webhooks/aws [-c deployTargetName=<project>]
 */
const deployTargetRepo: unknown = app.node.tryGetContext('deployTargetRepo');
if (typeof deployTargetRepo === 'string' && deployTargetRepo !== '') {
  const context = (key: string): string => {
    const value: unknown = app.node.tryGetContext(key);
    if (typeof value !== 'string' || value === '') throw new Error(`-c ${key}=... is required with deployTargetRepo`);
    return value;
  };
  const name = String(app.node.tryGetContext('deployTargetName') ?? `${deployTargetRepo.split('/').at(-1) ?? 'app'}-deploy`);
  new DeployTargetStack(app, `slop-${stage}-deploy-${name}`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
    repo: deployTargetRepo,
    connectionArn: context('deployTargetConnectionArn'),
    webhookUrl: context('deployTargetWebhookUrl'),
    projectName: name,
    tags: { project: 'slop', stage },
  });
}
