import { Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { FILE_ACCEPT, filesOf } from '@/lib/upload';
import { cn } from '@/lib/utils';

/**
 * Where files are added: click to pick, drag them in, or paste (a screenshot from the clipboard). It only hands the
 * files on; what happens to them (upload now, or after the glob is created) is the caller's.
 */
export const FileDropZone = ({
  onFiles,
  disabled = false,
  hint,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  hint?: string;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // Latest handler, so the page-level paste listener is set up once.
  const handler = useRef(onFiles);
  handler.current = onFiles;
  const off = useRef(disabled);
  off.current = disabled;

  // A paste anywhere on the page counts while the zone is shown; a text paste carries no files and is left alone.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (off.current) return;
      const files = filesOf(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      handler.current(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  return (
    <div
      className={cn(
        'grid justify-items-center gap-1 rounded border border-dashed p-3 text-xs text-muted-foreground',
        over && 'border-foreground bg-muted',
      )}
      data-testid="file-drop"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) onFiles(filesOf(e.dataTransfer));
      }}
    >
      <Upload className="h-4 w-4" aria-hidden />
      <p>
        Drop files here, paste a screenshot, or{' '}
        <button
          type="button"
          className="underline"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          pick files
        </button>
      </p>
      <p>{hint ?? 'Images, PDF, text, JSON, CSV, log or zip, up to 10 MiB each.'}</p>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={FILE_ACCEPT}
        aria-label="Files"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length > 0 && !disabled) onFiles(files);
        }}
      />
    </div>
  );
};

/** One file's row in an upload list: its name, a progress bar, or what went wrong. */
export interface UploadRow {
  readonly id: number;
  readonly name: string;
  readonly progress: number;
  readonly error: string | null;
  readonly done: boolean;
}

export const UploadRows = ({
  rows,
  onDismiss,
}: {
  rows: readonly UploadRow[];
  onDismiss: (id: number) => void;
}) =>
  rows.length === 0 ? null : (
    <ul className="grid gap-1 text-xs" data-testid="uploads">
      {rows.map((row) => (
        <li key={row.id} className="grid gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate">{row.name}</span>
            {row.error !== null ? (
              <>
                <span className="text-destructive" role="alert">
                  {row.error}
                </span>
                <button type="button" className="underline" onClick={() => onDismiss(row.id)}>
                  Dismiss
                </button>
              </>
            ) : row.done ? (
              <span className="text-muted-foreground">Uploaded</span>
            ) : (
              <span className="text-muted-foreground">{Math.round(row.progress * 100)}%</span>
            )}
          </div>
          {row.error === null && !row.done && (
            <div
              className="h-1 rounded bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(row.progress * 100)}
            >
              <div
                className="h-1 rounded bg-foreground"
                style={{ width: `${String(Math.round(row.progress * 100))}%` }}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
