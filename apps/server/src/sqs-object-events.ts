import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { AttachmentService } from '@slop/core';
import { z } from 'zod';

export interface QueueMessage {
  readonly receiptHandle: string;
  readonly body: string;
}

/** Where the bucket's object events arrive (an SQS queue in production, a fake in tests). */
export interface ObjectEventQueue {
  /** Waits for messages (long poll); an empty list when none came. */
  receive(): Promise<readonly QueueMessage[]>;
  /** Removes a handled message; one not removed comes back after the queue's visibility timeout. */
  remove(receiptHandle: string): Promise<void>;
}

export class SqsObjectEventQueue implements ObjectEventQueue {
  constructor(
    private readonly client: Pick<SQSClient, 'send'>,
    private readonly queueUrl: string,
    private readonly waitSeconds = 20,
  ) {}

  async receive(): Promise<readonly QueueMessage[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: this.waitSeconds }),
    );
    return (result.Messages ?? []).flatMap((m) => (m.ReceiptHandle === undefined || m.Body === undefined ? [] : [{ receiptHandle: m.ReceiptHandle, body: m.Body }]));
  }

  async remove(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }
}

const notification = z.object({
  Records: z
    .array(
      z.object({
        eventName: z.string(),
        s3: z.object({ object: z.object({ key: z.string(), size: z.number().optional() }) }),
      }),
    )
    .default([]),
});
// The same notification when it came through SNS: the S3 JSON is the envelope's `Message`.
const envelope = z.object({ Message: z.string() });

/** The created objects an S3 event notification names (S3 URL-encodes keys, spaces as `+`); empty for anything else. */
export const createdObjects = (body: string): { key: string; size: number | null }[] => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const wrapped = envelope.safeParse(json);
  if (wrapped.success) return createdObjects(wrapped.data.Message);
  const parsed = notification.safeParse(json);
  if (!parsed.success) return [];
  return parsed.data.Records.filter((r) => r.eventName.startsWith('ObjectCreated:')).map((r) => ({
    key: decodeURIComponent(r.s3.object.key.replace(/\+/g, ' ')),
    size: r.s3.object.size ?? null,
  }));
};

/**
 * Handles one batch of messages: each created object under `boards/` is offered to the service, and a message is removed
 * only once all its objects were handled (a failure leaves it for the queue to redeliver). Returns how many were removed.
 */
export const consumeObjectEvents = async (
  queue: ObjectEventQueue,
  attachments: Pick<AttachmentService, 'objectArrived'>,
  log: (task: string, message: string) => void,
): Promise<number> => {
  let removed = 0;
  for (const message of await queue.receive()) {
    try {
      for (const object of createdObjects(message.body)) {
        if (object.key.startsWith('boards/')) await attachments.objectArrived(object.key, object.size === null ? undefined : { size: object.size });
      }
      await queue.remove(message.receiptHandle);
      removed++;
    } catch (error) {
      log('attachment events', error instanceof Error ? error.message : String(error));
    }
  }
  return removed;
};
