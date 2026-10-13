import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, NotFound } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectInfo, ObjectStore, PresignedUpload } from '@slop/core';

/** The longest prefix every type shares (`image/png` and `image/jpeg` share `image/`); a single type is its own prefix. */
export const commonPrefix = (types: readonly string[]): string => {
  const [first, ...rest] = types;
  if (first === undefined) return '';
  let end = first.length;
  for (const type of rest) {
    let i = 0;
    while (i < end && type[i] === first[i]) i++;
    end = i;
  }
  return first.slice(0, end);
};

/** A `Content-Disposition` for a download: ASCII fallback name plus the UTF-8 one (RFC 6266). */
export const contentDisposition = (disposition: 'inline' | 'attachment', fileName: string): string => {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\;]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

/**
 * The attachments bucket through the AWS SDK (the instance role in production). Uploads are presigned POSTs, so S3
 * enforces the size range and the type; nothing passes through slop.
 */
export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async presignUpload(input: {
    readonly key: string;
    readonly maxBytes: number;
    readonly contentTypes: readonly string[];
    readonly ttlSeconds: number;
  }): Promise<PresignedUpload> {
    const prefix = commonPrefix(input.contentTypes);
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: input.key,
      Expires: input.ttlSeconds,
      Conditions: [
        ['content-length-range', 1, input.maxBytes],
        ['starts-with', '$Content-Type', prefix],
      ],
    });
    // The client must send a Content-Type the policy accepts; with one allowed type it is handed over ready to use.
    const [only, ...others] = input.contentTypes;
    return { url, fields: only !== undefined && others.length === 0 ? { ...fields, 'Content-Type': only } : fields };
  }

  presignDownload(
    key: string,
    ttlSeconds: number,
    options?: { readonly fileName?: string; readonly disposition?: 'inline' | 'attachment' },
  ): Promise<string> {
    const disposition = options?.disposition ?? 'attachment';
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options?.fileName === undefined ? {} : { ResponseContentDisposition: contentDisposition(disposition, options.fileName) }),
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: result.ContentLength ?? 0, contentType: result.ContentType ?? '' };
    } catch (error) {
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  /**
   * Why the bucket can't be reached now, or null when it can. Lists one key under `boards/`, the one bucket-level call the
   * server's policy allows (`s3:ListBucket` is conditioned on that prefix; HeadBucket carries none and is denied). Never throws.
   */
  async unreachableReason(signal?: AbortSignal): Promise<string | null> {
    try {
      await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: 'boards/', MaxKeys: 1 }), signal === undefined ? {} : { abortSignal: signal });
      return null;
    } catch (error) {
      if (signal?.aborted === true) return 'timeout';
      const name = error instanceof Error ? error.name : 'unknown error';
      return `bucket denied: ${name}`;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
