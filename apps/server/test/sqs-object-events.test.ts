import { describe, expect, it, vi } from 'vitest';
import { AttachmentEventsJob } from '../src/jobs/attachment-events.js';
import { consumeObjectEvents, createdObjects } from '../src/sqs-object-events.js';
import type { ObjectEventQueue, QueueMessage } from '../src/sqs-object-events.js';

const created = (key: string, size = 10, eventName = 'ObjectCreated:Post') =>
  JSON.stringify({ Records: [{ eventName, s3: { bucket: { name: 'b' }, object: { key, size } } }] });

class FakeQueue implements ObjectEventQueue {
  readonly removed: string[] = [];
  constructor(private batches: QueueMessage[][]) {}
  receive(): Promise<readonly QueueMessage[]> {
    return Promise.resolve(this.batches.shift() ?? []);
  }
  remove(receiptHandle: string): Promise<void> {
    this.removed.push(receiptHandle);
    return Promise.resolve();
  }
}

describe('createdObjects', () => {
  it('reads the created objects of an S3 notification, decoding the key', () => {
    expect(createdObjects(created('boards/1/globs/s1t1/a+b%2Bc', 42))).toEqual([{ key: 'boards/1/globs/s1t1/a b+c', size: 42 }]);
  });

  it('reads one that came through SNS', () => {
    expect(createdObjects(JSON.stringify({ Message: created('boards/1/x') }))).toEqual([{ key: 'boards/1/x', size: 10 }]);
  });

  it('ignores removals, test events and anything that is not JSON', () => {
    expect(createdObjects(created('boards/1/x', 1, 'ObjectRemoved:Delete'))).toEqual([]);
    expect(createdObjects(JSON.stringify({ Service: 'Amazon S3', Event: 's3:TestEvent' }))).toEqual([]);
    expect(createdObjects('not json')).toEqual([]);
  });
});

describe('consumeObjectEvents', () => {
  it('offers each created object under boards/ to the service and removes the handled messages', async () => {
    const objectArrived = vi.fn(() => Promise.resolve('stored' as const));
    const queue = new FakeQueue([
      [
        { receiptHandle: 'r1', body: created('boards/1/globs/s1t1/u1', 77) },
        { receiptHandle: 'r2', body: created('elsewhere/file') },
        { receiptHandle: 'r3', body: 'junk' },
      ],
    ]);
    expect(await consumeObjectEvents(queue, { objectArrived }, () => undefined)).toBe(3);
    expect(objectArrived.mock.calls).toEqual([['boards/1/globs/s1t1/u1', { size: 77 }]]);
    expect(queue.removed).toEqual(['r1', 'r2', 'r3']);
  });

  it('leaves a message whose handling failed on the queue and carries on with the rest', async () => {
    const objectArrived = vi.fn((key: string) => (key.endsWith('bad') ? Promise.reject(new Error('db down')) : Promise.resolve('stored' as const)));
    const queue = new FakeQueue([
      [
        { receiptHandle: 'r1', body: created('boards/1/bad') },
        { receiptHandle: 'r2', body: created('boards/1/good') },
      ],
    ]);
    const log = vi.fn();
    expect(await consumeObjectEvents(queue, { objectArrived }, log)).toBe(1);
    expect(queue.removed).toEqual(['r2']);
    expect(log).toHaveBeenCalledWith('attachment events', 'db down');
  });
});

describe('AttachmentEventsJob', () => {
  it('polls the queue through the service, and sweeps once at a time', async () => {
    const sweep = vi.fn(() => Promise.resolve({ stored: 0, refused: 0, expired: 0 }));
    const objectArrived = vi.fn(() => Promise.resolve('ignored' as const));
    const job = new AttachmentEventsJob({ sweep, objectArrived }, null, () => undefined);
    const queue = new FakeQueue([[{ receiptHandle: 'r1', body: created('boards/1/x') }]]);
    expect(await job.poll(queue)).toBe(1);
    expect(objectArrived).toHaveBeenCalledTimes(1);
    await Promise.all([job.sweep(), job.sweep()]);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('logs a failed sweep instead of throwing', async () => {
    const log = vi.fn();
    const job = new AttachmentEventsJob({ sweep: () => Promise.reject(new Error('boom')), objectArrived: () => Promise.resolve('ignored') }, null, log);
    await job.sweep();
    expect(log).toHaveBeenCalledWith('attachment sweep', 'boom');
  });
});
