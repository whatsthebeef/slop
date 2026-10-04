import { App } from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack.js';

const app = new App();
const stage = String(app.node.tryGetContext('stage') ?? 'dev');
const csv = (key: string, fallback: string[]): string[] => {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter((s) => s !== '') : fallback;
};

new AuthStack(app, `slop-${stage}-auth`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  stage,
  boardCallbackUrls: csv('boardCallbackUrls', ['http://localhost:3000/auth/callback', 'http://localhost:5173/auth/callback']),
  boardLogoutUrls: csv('boardLogoutUrls', ['http://localhost:3000/', 'http://localhost:5173/']),
  claudeCodeCallbackUrls: csv('claudeCodeCallbackUrls', ['http://localhost:7779/callback']),
  identityCenterMetadataUrl: (app.node.tryGetContext('identityCenterMetadataUrl') as string | undefined) ?? null,
  tags: { project: 'slop', stage },
});
