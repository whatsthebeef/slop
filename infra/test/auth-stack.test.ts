import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AuthStack } from '../lib/auth-stack.js';

const synth = (): Template => {
  const app = new App();
  const stack = new AuthStack(app, 'Auth', {
    env: { account: '123456789012', region: 'us-east-1' },
    stage: 'dev',
    boardCallbackUrls: ['http://localhost:3000/auth/callback'],
    boardLogoutUrls: ['http://localhost:3000/'],
    claudeCodeCallbackUrls: ['http://localhost:7779/callback'],
    cliCallbackUrls: ['http://localhost:7780/callback'],
    identityCenterMetadataUrl: null,
  });
  return Template.fromStack(stack);
};

describe('AuthStack', () => {
  it('keeps one resource server `slop` with the MCP scope and the two ATF runner scopes', () => {
    const t = synth();
    t.resourceCountIs('AWS::Cognito::UserPoolResourceServer', 1);
    const [server] = Object.values(t.findResources('AWS::Cognito::UserPoolResourceServer'));
    const properties = server?.Properties as {
      Identifier: string;
      Scopes: { ScopeName: string }[];
    };
    expect(properties.Identifier).toBe('slop');
    expect(properties.Scopes.map((s) => s.ScopeName).sort()).toEqual([
      'atf.read-specs',
      'atf.write-results',
      'mcp',
    ]);
  });

  it('gives none of its own app clients the ATF scopes', () => {
    const t = synth();
    for (const client of Object.values(t.findResources('AWS::Cognito::UserPoolClient'))) {
      const scopes =
        (client.Properties as { AllowedOAuthScopes?: unknown[] }).AllowedOAuthScopes ?? [];
      expect(JSON.stringify(scopes)).not.toContain('atf.');
    }
  });
});
