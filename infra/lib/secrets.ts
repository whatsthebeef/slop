import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Grant } from 'aws-cdk-lib/aws-iam';
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { CfnSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface SlopSecretsProps {
  /** `dev` or `prod`; names the secrets `slop/<stage>/...`. Must match the server's `SECRETS_PREFIX` (`slop/prod/`). */
  readonly stage: string;
}

/**
 * The secrets production slop reads at start (server `SECRETS=aws`, `apps/server/src/secrets.ts` `secretNames`):
 *
 *   slop/<stage>/signing-secret               generated here
 *   slop/<stage>/cognito-board-client-secret  empty: put the board app client's secret (s15f34's auth stack)
 *   slop/<stage>/slack-signing-secret         empty, optional (set both Slack secrets or neither)
 *   slop/<stage>/slack-bot-token              empty, optional
 *   slop/<stage>/github-app                   empty: the GitHub App manifest flow writes it
 *   slop/<stage>/routines/<email>/<board|default>   created by slop when a routine is set
 *
 * The empty ones have no value until someone sets it (`aws secretsmanager put-secret-value`); the server reads
 * a secret with no value as missing and, for a required one, refuses to start naming it.
 *
 * s15f32 calls `grantServer(instanceRole)` on the server's EC2 instance role.
 */
export class SlopSecrets extends Construct {
  readonly prefix: string;
  private readonly fixed: CfnSecret[] = [];
  private readonly writable: CfnSecret[] = [];

  constructor(scope: Construct, id: string, props: SlopSecretsProps) {
    super(scope, id);
    this.prefix = `slop/${props.stage}/`;
    const retain = props.stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const make = (key: string, name: string, description: string, generate: boolean): CfnSecret => {
      const secret = new CfnSecret(this, key, {
        name: `${this.prefix}${name}`,
        description,
        ...(generate ? { generateSecretString: { excludePunctuation: true, passwordLength: 48 } } : {}),
      });
      secret.applyRemovalPolicy(retain);
      this.fixed.push(secret);
      return secret;
    };

    make('SigningSecret', 'signing-secret', 'Signs slop sign-in state and download links', true);
    make('CognitoBoardClientSecret', 'cognito-board-client-secret', "The board's Cognito app client secret", false);
    make('SlackSigningSecret', 'slack-signing-secret', "The Slack app's signing secret (optional)", false);
    make('SlackBotToken', 'slack-bot-token', "The Slack app's bot token, xoxb-... (optional)", false);
    this.writable.push(make('GithubApp', 'github-app', "The GitHub App's credentials (JSON), written by the manifest flow", false));

    new CfnOutput(this, 'SecretsPrefix', { value: this.prefix, description: "The server's SECRETS_PREFIX" });
  }

  /**
   * Lets the server read every secret, replace the GitHub App's, and create and replace routines
   * (`routines/*`). Nothing else is writable.
   */
  grantServer(grantee: IGrantable): void {
    Grant.addToPrincipal({
      grantee,
      actions: ['secretsmanager:GetSecretValue'],
      resourceArns: [...this.fixed.map((s) => s.ref), this.routinesArn()],
    });
    Grant.addToPrincipal({
      grantee,
      actions: ['secretsmanager:PutSecretValue'],
      resourceArns: [...this.writable.map((s) => s.ref), this.routinesArn()],
    });
    Grant.addToPrincipal({ grantee, actions: ['secretsmanager:CreateSecret'], resourceArns: [this.routinesArn()] });
  }

  private routinesArn(): string {
    // Secrets Manager appends a random suffix to the ARN, hence the trailing wildcard.
    return `arn:aws:secretsmanager:*:*:secret:${this.prefix}routines/*`;
  }
}
