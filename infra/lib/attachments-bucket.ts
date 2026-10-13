import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { IRole } from 'aws-cdk-lib/aws-iam';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  EventType,
  HttpMethods,
} from 'aws-cdk-lib/aws-s3';
import { SqsDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface AttachmentsBucketProps {
  /** `prod`; names the bucket and decides whether it is kept when the stack is deleted. */
  readonly stage: string;
  /**
   * The origins the board runs at (the public address and its aliases). Browsers upload with a presigned POST and
   * download with a presigned GET from these origins only. They may be tokens, resolved at deploy time.
   */
  readonly appOrigins: readonly string[];
  /** The role the server runs as: it may read, write, delete and head the objects and consume the event queue. */
  readonly serverRole: IRole;
}

/** Objects live under `boards/<board>/globs/<globId>/<uuid>`; only this prefix raises events. */
export const ATTACHMENT_KEY_PREFIX = 'boards/';
/** How long an unconsumed event stays in the queue. The server also finds uploads by `head`, so a lost event only delays detection. */
const EVENT_RETENTION = Duration.days(4);

/**
 * Glob attachments (s15f78): a private bucket the browser and agents upload to with presigned POSTs, and an SQS queue
 * the server consumes to learn that an object arrived. The bytes never pass through slop.
 *
 *   uploader ──presigned POST──▶ S3 (boards/…) ──ObjectCreated──▶ SQS ──▶ server (marks the attachment stored)
 */
export class AttachmentsBucket extends Construct {
  readonly bucket: Bucket;
  readonly queue: Queue;
  readonly deadLetterQueue: Queue;

  constructor(scope: Construct, id: string, props: AttachmentsBucketProps) {
    super(scope, id);
    const { stage, serverRole } = props;
    const production = stage === 'prod';
    if (props.appOrigins.length === 0)
      throw new Error('appOrigins: at least one origin may upload');

    this.bucket = new Bucket(this, 'Bucket', {
      bucketName: `slop-${stage}-attachments-${Stack.of(this).account}`,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !production,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      cors: [
        {
          allowedMethods: [HttpMethods.POST, HttpMethods.GET],
          allowedOrigins: [...props.appOrigins],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });

    this.deadLetterQueue = new Queue(this, 'EventsDeadLetter', {
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    this.queue = new Queue(this, 'Events', {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: EVENT_RETENTION,
      visibilityTimeout: Duration.seconds(60),
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 5 },
    });
    this.bucket.addEventNotification(EventType.OBJECT_CREATED, new SqsDestination(this.queue), {
      prefix: ATTACHMENT_KEY_PREFIX,
    });

    // A standalone policy, not role.addToPolicy: the host instance depends on its role, and the bucket's CORS origins
    // depend on the distribution, which depends on the instance. A policy the role doesn't own breaks that cycle.
    const policy = new Policy(this, 'ServerAccess', {
      statements: [
        new PolicyStatement({
          actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
          resources: [this.bucket.arnForObjects(`${ATTACHMENT_KEY_PREFIX}*`)],
        }),
        // HeadObject is authorised by s3:GetObject; ListBucket makes a missing key a 404 rather than a 403.
        new PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: [this.bucket.bucketArn],
          conditions: { StringLike: { 's3:prefix': [`${ATTACHMENT_KEY_PREFIX}*`] } },
        }),
        new PolicyStatement({
          actions: [
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:ChangeMessageVisibility',
            'sqs:GetQueueAttributes',
            'sqs:GetQueueUrl',
          ],
          resources: [this.queue.queueArn],
        }),
      ],
    });
    policy.attachToRole(serverRole);

    new CfnOutput(this, 'AttachmentsBucketName', {
      value: this.bucket.bucketName,
      description: "The server's ATTACHMENTS_BUCKET (add it to /slop/<stage>/server-env)",
    });
    new CfnOutput(this, 'AttachmentsQueueUrl', {
      value: this.queue.queueUrl,
      description: "The server's ATTACHMENTS_QUEUE_URL (add it to /slop/<stage>/server-env)",
    });
  }
}
