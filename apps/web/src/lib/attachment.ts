import { baseType, missingFileNote } from '@slop/core';
import type { AttachmentFile } from '@slop/core';
import type { ArtifactView } from './api';

/** Images the browser can show as a thumbnail (svg is always a download, so it never gets one). */
const THUMBNAIL_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const hasThumbnail = (file: Pick<AttachmentFile, 'contentType' | 'state'>): boolean =>
  file.state === 'stored' && THUMBNAIL_TYPES.includes(baseType(file.contentType));

/** "12 KB", "1.4 MB": the size as a person reads it. */
export const sizeText = (bytes: number | null): string => {
  if (bytes === null) return '';
  if (bytes < 1000) return `${String(bytes)} B`;
  if (bytes < 1_000_000) return `${String(Math.round(bytes / 100) / 10)} KB`;
  return `${String(Math.round(bytes / 100_000) / 10)} MB`;
};

/** What the entry says about its file in the list: waiting, never arrived (with the note), or the type and size. */
export const fileStatus = (
  artifact: Pick<ArtifactView, 'file' | 'createdAt' | 'provenance'>,
): { readonly text: string; readonly missing: boolean } | null => {
  const file = artifact.file;
  if (file === null || file === undefined) return null;
  if (file.state === 'pending')
    return { text: `${file.fileName}: waiting for upload`, missing: false };
  if (file.state === 'missing') {
    return {
      text: missingFileNote(artifact) ?? `${file.fileName} was never uploaded`,
      missing: true,
    };
  }
  return {
    text: [file.fileName, sizeText(file.size)].filter((p) => p !== '').join(' · '),
    missing: false,
  };
};
