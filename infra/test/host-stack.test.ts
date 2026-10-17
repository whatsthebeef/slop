import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { HostStack } from '../lib/host-stack.js';
import { SlopSecrets } from '../lib/secrets.js';
import { Stack } from 'aws-cdk-lib';

const env = { account: '123456789012', region: 'us-east-1' };

const synth = (stage: string, extra: { amiId?: string; dataVolumeId?: string; cognitoUserPoolId?: string; deployProjects?: string[] } = {}): Template => {
  const app = new App();
  const secrets = new SlopSecrets(new Stack(app, 'Secrets', { env }), 'Secrets', { stage });
  const stack = new HostStack(app, 'Host', {
    env,
    stage,
    secrets,
    connectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/x',
    repo: 'o/r',
    branch: 'main',
    cloudFrontPrefixListId: 'pl-3b927c52',
    ...extra,
  });
  return Template.fromStack(stack);
};

const prod = { amiId: 'ami-0123456789abcdef0', dataVolumeId: 'vol-0123456789abcdef0' };

describe('HostStack', () => {
  it('pins the AMI and attaches the existing data volume in prod without creating one', () => {
    const t = synth('prod', prod);
    t.hasResourceProperties('AWS::EC2::Instance', { ImageId: 'ami-0123456789abcdef0' });
    t.hasResourceProperties('AWS::EC2::VolumeAttachment', { Device: '/dev/sdf', VolumeId: 'vol-0123456789abcdef0' });
    t.resourceCountIs('AWS::EC2::Volume', 0);
  });

  it('keeps the data disk out of the instance block device mapping', () => {
    const t = synth('prod', prod);
    const instance = Object.values(t.findResources('AWS::EC2::Instance'))[0];
    if (instance === undefined) throw new Error('no instance');
    const properties = instance.Properties as { BlockDeviceMappings?: { DeviceName: string }[] };
    const devices = properties.BlockDeviceMappings ?? [];
    expect(devices.map((d) => d.DeviceName)).toEqual(['/dev/xvda']);
  });

  it('refuses to synthesise prod without a pinned AMI and data volume', () => {
    expect(() => synth('prod')).toThrow(/hostAmiId/);
    expect(() => synth('prod', { amiId: prod.amiId })).toThrow(/hostDataVolumeId/);
  });

  it('creates a retained, snapshot-tagged data volume for a stage without one', () => {
    const t = synth('dev');
    t.hasResource('AWS::EC2::Volume', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ Size: 30, Encrypted: true, Tags: Match.arrayWith([{ Key: 'slop:snapshot', Value: 'weekly' }]) }),
    });
    t.resourceCountIs('AWS::EC2::VolumeAttachment', 1);
  });

  const cognitoStatements = (t: Template): { Action: string[]; Resource: unknown }[] =>
    Object.values(t.findResources('AWS::IAM::Policy')).flatMap((policy) => {
      const document = (policy.Properties as { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } }).PolicyDocument;
      return document.Statement.flatMap((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.some((a) => a.startsWith('cognito-idp:')) ? [{ Action: actions, Resource: s.Resource }] : [];
      });
    });

  it('lets the instance manage ATF runners\' app clients on the given pool only', () => {
    const t = synth('dev', { cognitoUserPoolId: 'us-east-1_AbCdEf123' });
    const statements = cognitoStatements(t);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action.sort()).toEqual([
      'cognito-idp:CreateUserPoolClient',
      'cognito-idp:DeleteUserPoolClient',
      'cognito-idp:DescribeResourceServer',
      'cognito-idp:DescribeUserPoolClient',
    ]);
    expect(JSON.stringify(statements[0]?.Resource)).toContain('userpool/us-east-1_AbCdEf123');
    expect(JSON.stringify(statements[0]?.Resource)).not.toContain('*');
  });

  it('grants nothing on Cognito without a pool', () => {
    expect(cognitoStatements(synth('dev'))).toEqual([]);
  });

  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

  // Read from the synthesised template as unknown data, narrowed rather than cast.
  const statementsFor = (t: Template, prefix: string): { Action: string[]; Resource: unknown }[] =>
    Object.values(t.findResources('AWS::IAM::Policy')).flatMap((policy: unknown) => {
      const properties = isRecord(policy) ? policy['Properties'] : undefined;
      const document = isRecord(properties) ? properties['PolicyDocument'] : undefined;
      const statements: unknown[] = isRecord(document) && Array.isArray(document['Statement']) ? document['Statement'] : [];
      return statements.flatMap((s) => {
        if (!isRecord(s)) return [];
        const action = s['Action'];
        const actions = (Array.isArray(action) ? action : [action]).filter((a): a is string => typeof a === 'string');
        return actions.some((a) => a.startsWith(prefix)) ? [{ Action: actions, Resource: s['Resource'] }] : [];
      });
    });

  // The host's own log grants (the CloudWatch agent) are not the build logs.
  const buildLogStatements = (t: Template) => statementsFor(t, 'logs:GetLogEvents').filter((s) => JSON.stringify(s.Resource).includes('/aws/codebuild/'));

  it('lets the instance read each deploy project\'s CodeBuild log group, the same projects it may start', () => {
    const t = synth('dev', { deployProjects: ['dev-megarepo', 'dev-other'] });
    const [start] = statementsFor(t, 'codebuild:');
    const [logs, ...rest] = buildLogStatements(t);
    expect(rest).toEqual([]);
    expect(logs?.Action.sort()).toEqual(['logs:DescribeLogStreams', 'logs:GetLogEvents']);
    const resources = JSON.stringify(logs?.Resource);
    for (const name of ['dev-megarepo', 'dev-other']) {
      expect(resources).toContain(`log-group:/aws/codebuild/${name}:*`);
      expect(JSON.stringify(start?.Resource)).toContain(`project/${name}`);
    }
    // Only the build log groups, never every log group.
    expect(resources).not.toContain('log-group:*');
  });

  it('grants no log access without deploy projects', () => {
    expect(buildLogStatements(synth('dev'))).toEqual([]);
  });
});
