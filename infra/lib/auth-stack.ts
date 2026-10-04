import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  OAuthScope,
  ProviderAttribute,
  ResourceServerScope,
  UserPool,
  UserPoolClientIdentityProvider,
  UserPoolIdentityProviderSaml,
  UserPoolIdentityProviderSamlMetadata,
} from 'aws-cdk-lib/aws-cognito';
import type { UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

export interface AuthStackProps extends StackProps {
  readonly stage: string;
  readonly boardCallbackUrls: readonly string[];
  readonly boardLogoutUrls: readonly string[];
  /** Claude Code's OAuth redirect (`claude mcp add --callback-port`); verified in slice 1. */
  readonly claudeCodeCallbackUrls: readonly string[];
  /** sstor's own OAuth redirect (`sstor login`), so sstor calls slop without going through Claude. */
  readonly sstorCallbackUrls: readonly string[];
  /**
   * The SAML metadata URL of the custom application in IAM Identity Center. Without it the pool
   * only has native users (local development); with it sign-in is federated to Identity Center.
   */
  readonly identityCenterMetadataUrl: string | null;
}

const TEN_YEARS = Duration.days(3650);

/**
 * Cognito for slop: the authorization server for the board, the Claude app connector, routines,
 * Claude Code and sstor. Roles live in slop; Cognito only answers who someone is.
 */
export class AuthStack extends Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const production = props.stage === 'prod';

    const pool = new UserPool(this, 'Users', {
      userPoolName: `slop-${props.stage}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      deletionProtection: production,
      removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const domain = pool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `slop-${props.stage}-${this.account}` },
    });

    // The MCP endpoint is the protected resource; tokens for it carry this scope.
    const mcpScope = new ResourceServerScope({ scopeName: 'mcp', scopeDescription: 'Use slop through MCP' });
    const resourceServer = pool.addResourceServer('Slop', { identifier: 'slop', scopes: [mcpScope] });

    const providers: UserPoolClientIdentityProvider[] = [UserPoolClientIdentityProvider.COGNITO];
    if (props.identityCenterMetadataUrl !== null) {
      const identityCenter = new UserPoolIdentityProviderSaml(this, 'IdentityCenter', {
        userPool: pool,
        name: 'IdentityCenter',
        metadata: UserPoolIdentityProviderSamlMetadata.url(props.identityCenterMetadataUrl),
        attributeMapping: { email: ProviderAttribute.other('email') },
      });
      providers.push(UserPoolClientIdentityProvider.custom(identityCenter.providerName));
    }

    const baseScopes = [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE];
    const mcp = OAuthScope.resourceServer(resourceServer, mcpScope);
    const client = (
      id: string,
      options: { secret: boolean; callbacks: readonly string[]; logouts?: readonly string[]; mcp: boolean },
    ): UserPoolClient => {
      const created = pool.addClient(id, {
        userPoolClientName: `slop-${props.stage}-${id.toLowerCase()}`,
        generateSecret: options.secret,
        authFlows: { user: false, userPassword: false, userSrp: false },
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: options.mcp ? [...baseScopes, mcp] : baseScopes,
          callbackUrls: [...options.callbacks],
          logoutUrls: [...(options.logouts ?? [])],
        },
        supportedIdentityProviders: providers,
        accessTokenValidity: Duration.hours(1),
        idTokenValidity: Duration.hours(1),
        // Each person logs in once; deactivation in slop and token revocation handle leaks.
        refreshTokenValidity: TEN_YEARS,
        enableTokenRevocation: true,
        preventUserExistenceErrors: true,
      });
      created.node.addDependency(resourceServer);
      return created;
    };

    const board = client('Board', {
      secret: true,
      callbacks: props.boardCallbackUrls,
      logouts: props.boardLogoutUrls,
      mcp: false,
    });
    const connector = client('ClaudeConnector', {
      secret: true,
      callbacks: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
      mcp: true,
    });
    const claudeCode = client('ClaudeCode', { secret: false, callbacks: props.claudeCodeCallbackUrls, mcp: true });
    const sstor = client('Sstor', { secret: false, callbacks: props.sstorCallbackUrls, mcp: true });

    new CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new CfnOutput(this, 'Domain', { value: `${domain.domainName}.auth.${this.region}.amazoncognito.com` });
    new CfnOutput(this, 'BoardClientId', { value: board.userPoolClientId });
    new CfnOutput(this, 'ClaudeConnectorClientId', { value: connector.userPoolClientId });
    new CfnOutput(this, 'ClaudeCodeClientId', { value: claudeCode.userPoolClientId });
    new CfnOutput(this, 'SstorClientId', { value: sstor.userPoolClientId });
    new CfnOutput(this, 'ClientIds', {
      value: [board, connector, claudeCode, sstor].map((c) => c.userPoolClientId).join(','),
      description: 'COGNITO_CLIENT_IDS for the server',
    });
  }
}
