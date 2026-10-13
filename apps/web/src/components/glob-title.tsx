import type { EditFailure } from '@slop/core';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { GlobChanges } from '@/lib/api';
import { useTitleEdit } from '@/lib/title-edit';

/** The glob's ID and title as the page heading; the title edits in place when `editable`. */
export const GlobTitle = ({
  id,
  title,
  editable,
  onUpdate,
  onReload,
}: {
  id: string;
  title: string;
  editable: boolean;
  onUpdate: (changes: GlobChanges) => Promise<EditFailure | null>;
  onReload: () => Promise<void>;
}) => {
  const { editing, text, saving, error, emptyRefused, field, begin, commit, change, onKeyDown, reload } = useTitleEdit({
    title,
    resetKey: id,
    onUpdate,
    onReload,
  });

  if (!editing) {
    return (
      <h1 className='group flex min-w-0 flex-1 items-baseline gap-1.5 text-base font-semibold' data-testid='glob-title'>
        <span className='shrink-0 font-mono text-muted-foreground'>{id}</span>
        {editable ? (
          <button
            type='button'
            className='flex min-w-0 items-baseline gap-1.5 rounded text-left font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            onClick={begin}
            aria-label={`Edit title: ${title}`}
            data-testid='glob-title-edit'
          >
            <span className='truncate' title={title}>{title}</span>
            <Pencil aria-hidden className='size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100' />
          </button>
        ) : (
          <span className='truncate'>{title}</span>
        )}
      </h1>
    );
  }
  return (
    <div className='relative min-w-0 flex-1'>
      <h1 className='flex items-baseline gap-1.5 text-base font-semibold'>
        <span className='shrink-0 font-mono text-muted-foreground'>{id}</span>
        <input
          ref={field}
          autoFocus
          value={text}
          disabled={saving}
          aria-label='Title'
          aria-invalid={emptyRefused || error !== null}
          data-testid='glob-title-input'
          className='min-w-0 flex-1 rounded border bg-card px-1 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring'
          onChange={(e) => change(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
        {saving && (
          <span role='status' className='shrink-0 text-xs font-normal text-muted-foreground'>
            Saving…
          </span>
        )}
      </h1>
      {emptyRefused && (
        <p role='alert' className='absolute left-0 top-full z-20 rounded bg-background px-1 text-xs text-red'>
          The title can't be empty.
        </p>
      )}
      {error !== null && (
        <div role='alert' className='absolute left-0 top-full z-20 flex flex-wrap items-center gap-2 rounded bg-background px-1 text-xs text-red'>
          <span>{error.message}</span>
          {error.conflict && (
            <Button
              variant='outline'
              size='sm'
              disabled={saving}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void reload()}
            >
              Reload latest
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
