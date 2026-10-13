import type { ObjectInfo, ObjectStore, PresignedUpload } from '../ports.js';

export interface PresignedUploadCall {
  readonly key: string;
  readonly maxBytes: number;
  readonly contentTypes: readonly string[];
  readonly ttlSeconds: number;
}

/** In-memory object storage for tests: `put` stands in for the client's upload landing in the bucket. */
export class FakeObjectStore implements ObjectStore {
  readonly objects = new Map<string, ObjectInfo>();
  readonly uploads: PresignedUploadCall[] = [];
  readonly deleted: string[] = [];
  readonly downloads: { readonly key: string; readonly ttlSeconds: number; readonly disposition: string | null }[] = [];

  presignUpload(input: PresignedUploadCall): Promise<PresignedUpload> {
    this.uploads.push(input);
    return Promise.resolve({ url: 'https://fake-bucket.s3.example.com/', fields: { key: input.key, 'Content-Type': input.contentTypes[0] ?? '' } });
  }

  presignDownload(key: string, ttlSeconds: number, options?: { readonly disposition?: 'inline' | 'attachment' }): Promise<string> {
    this.downloads.push({ key, ttlSeconds, disposition: options?.disposition ?? null });
    return Promise.resolve(`https://fake-bucket.s3.example.com/${key}?ttl=${String(ttlSeconds)}`);
  }

  head(key: string): Promise<ObjectInfo | null> {
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deleted.push(key);
    return Promise.resolve();
  }

  put(key: string, info: ObjectInfo): void {
    this.objects.set(key, info);
  }
}
