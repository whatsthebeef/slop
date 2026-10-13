import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import { AttachmentsBucket } from '../lib/attachments-bucket.js';

const synth = (stage = 'prod', appOrigins = ['https://slop.example.com']): Template => {
  const stack = new Stack(new App(), 'Test', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const serverRole = new Role(stack, 'Server', {
    assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
  });
  new AttachmentsBucket(stack, 'Attachments', { stage, appOrigins, serverRole });
  return Template.fromStack(stack);
};

describe('AttachmentsBucket', () => {
  it('is private, encrypted and TLS-only', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'slop-prod-attachments-123456789012',
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('allows POST and GET from the app origins only', () => {
    const t = synth('prod', ['https://a.example.com', 'https://b.example.com']);
    t.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedMethods: ['POST', 'GET'],
            AllowedOrigins: ['https://a.example.com', 'https://b.example.com'],
          }),
        ],
      },
    });
  });

  it('refuses to be built without an origin', () => {
    expect(() => synth('prod', [])).toThrow(/origin/);
  });

  it('sends ObjectCreated under boards/ to the queue', () => {
    const t = synth();
    t.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        QueueConfigurations: [
          Match.objectLike({
            Events: ['s3:ObjectCreated:*'],
            Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'boards/' }] } },
          }),
        ],
      },
    });
    t.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 's3.amazonaws.com' },
            Action: Match.arrayWith(['sqs:SendMessage']),
          }),
        ]),
      },
    });
  });

  it('gives undelivered events a dead-letter queue', () => {
    synth().hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
  });

  it('grants the server role object access and queue consumption, and nothing wider', () => {
    const t = synth();
    const statements = Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
      (p) =>
        (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } })
          .Properties.PolicyDocument.Statement,
    );
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).toEqual(
      expect.arrayContaining([
        's3:PutObject',
        's3:GetObject',
        's3:DeleteObject',
        's3:ListBucket',
        'sqs:ReceiveMessage',
        'sqs:DeleteMessage',
      ]),
    );
    expect(actions.filter((a) => a.includes('*'))).toEqual([]);
  });

  it('keeps production data and clears other stages', () => {
    synth('prod').hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    synth('dev').hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  });

  it('exports the names the server is configured with', () => {
    const t = synth();
    t.hasOutput('*', { Description: Match.stringLikeRegexp('ATTACHMENTS_BUCKET') });
    t.hasOutput('*', { Description: Match.stringLikeRegexp('ATTACHMENTS_QUEUE_URL') });
  });
});
