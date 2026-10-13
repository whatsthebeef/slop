import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { commonPrefix, contentDisposition, S3ObjectStore } from '../src/s3-object-store.js';

const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' } });
const store = new S3ObjectStore(client, 'attachments-bucket');

const policyOf = (fields: Readonly<Record<string, string>>): { expiration: string; conditions: unknown[] } => {
  const decoded: unknown = JSON.parse(Buffer.from(fields.Policy ?? '', 'base64').toString('utf8'));
  if (typeof decoded !== 'object' || decoded === null || !('conditions' in decoded) || !Array.isArray(decoded.conditions) || !('expiration' in decoded) || typeof decoded.expiration !== 'string') {
    throw new Error('Not a POST policy');
  }
  return { expiration: decoded.expiration, conditions: decoded.conditions };
};

describe('S3ObjectStore.presignUpload', () => {
  it('signs a POST to the bucket for the key with a size range and a Content-Type prefix condition', async () => {
    const key = 'boards/1/globs/s1t1/uuid-1';
    const before = Date.now();
    const upload = await store.presignUpload({ key, maxBytes: 5000, contentTypes: ['image/png'], ttlSeconds: 900 });
    expect(upload.url).toContain('attachments-bucket');
    expect(upload.fields.key).toBe(key);
    expect(upload.fields['Content-Type']).toBe('image/png');
    expect(upload.fields['X-Amz-Signature']).toBeTruthy();
    const policy = policyOf(upload.fields);
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 5000]);
    expect(policy.conditions).toContainEqual(['starts-with', '$Content-Type', 'image/png']);
    expect(policy.conditions).toContainEqual({ key });
    expect(policy.conditions).toContainEqual({ bucket: 'attachments-bucket' });
    const expires = Date.parse(policy.expiration);
    expect(expires).toBeGreaterThan(before + 890_000);
    expect(expires).toBeLessThan(Date.now() + 910_000);
  });

  it('allows the family several types share, and hands no Content-Type over when the client has to choose', async () => {
    const upload = await store.presignUpload({ key: 'k', maxBytes: 10, contentTypes: ['image/png', 'image/jpeg'], ttlSeconds: 60 });
    expect(policyOf(upload.fields).conditions).toContainEqual(['starts-with', '$Content-Type', 'image/']);
    expect(upload.fields['Content-Type']).toBeUndefined();
  });
});

describe('S3ObjectStore.presignDownload', () => {
  it('signs a GET that expires in the time given and sets the disposition', async () => {
    const url = new URL(await store.presignDownload('boards/1/globs/s1t1/uuid-1', 900, { fileName: 'Shot "1".png', disposition: 'attachment' }));
    expect(url.hostname).toContain('attachments-bucket');
    expect(url.pathname).toBe('/boards/1/globs/s1t1/uuid-1');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('response-content-disposition')).toBe(contentDisposition('attachment', 'Shot "1".png'));
  });
});

describe('helpers', () => {
  it('finds the common prefix of content types', () => {
    expect(commonPrefix(['image/png'])).toBe('image/png');
    expect(commonPrefix(['image/png', 'image/jpeg'])).toBe('image/');
    expect(commonPrefix(['image/png', 'application/pdf'])).toBe('');
    expect(commonPrefix([])).toBe('');
  });

  it('keeps a file name out of the header syntax', () => {
    expect(contentDisposition('inline', 'a"b;c.png')).toBe(`inline; filename="a_b_c.png"; filename*=UTF-8''a%22b%3Bc.png`);
    expect(contentDisposition('inline', 'é.png')).toContain('filename="_.png"');
  });
});

describe('S3ObjectStore.unreachableReason', () => {
  const sending = (send: (command: unknown) => Promise<unknown>) => {
    const sent: { input: unknown; name: string }[] = [];
    const fake = { send: (command: { input: unknown; constructor: { name: string } }) => (sent.push({ input: command.input, name: command.constructor.name }), send(command)) };
    return { store: new S3ObjectStore(fake as unknown as S3Client, 'attachments-bucket'), sent };
  };

  it('lists one key under boards/ (the call the policy allows) and is null when it answers', async () => {
    const { store: probing, sent } = sending(() => Promise.resolve({}));
    expect(await probing.unreachableReason()).toBeNull();
    expect(sent).toEqual([{ name: 'ListObjectsV2Command', input: { Bucket: 'attachments-bucket', Prefix: 'boards/', MaxKeys: 1 } }]);
  });

  it('names the error when the bucket denies the call', async () => {
    const { store: probing } = sending(() => Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDenied' })));
    expect(await probing.unreachableReason()).toBe('bucket denied: AccessDenied');
  });

  it('says timeout when the probe was aborted', async () => {
    const { store: probing } = sending(() => Promise.reject(new Error('aborted')));
    expect(await probing.unreachableReason(AbortSignal.abort())).toBe('timeout');
  });
});
