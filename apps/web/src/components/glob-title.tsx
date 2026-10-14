import type { EditFailure } from '@slop/core';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import type { GlobChanges } from '@/lib/api';
import { useTitleEdit } from '@/lib/title-edit';

/** The glob's title as the page heading (its ID is in the bar): the title wraps over as many lines as it needs and edits in place (a textarea) when `editable`. */
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

  // Grow with the text, so the whole title shows while it is typed.
  useEffect(() => {
    const el = field.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${String(el.scrollHeight)}px`;
  }, [field, text, editing]);

  if (!editing) {
    return (
      <h1 className='min-w-0 flex-1 text-xl font-semibold' data-testid='glob-title'>
        {editable ? (
          <span
            role='button'
            tabIndex={0}
            title='Click to edit'
            aria-label='Edit title'
            className='block min-w-0 cursor-text rounded break-words hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            onClick={begin}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                begin();
              }
            }}
            data-testid='glob-title-edit'
          >
            {title}
          </span>
        ) : (
          <span className='block min-w-0 break-words'>{title}</span>
        )}
      </h1>
    );
  }
  return (
    <div className='relative min-w-0 flex-1'>
      <h1 className='flex items-start gap-1.5 text-xl font-semibold'>
        <textarea
          ref={field}
          rows={1}
          autoFocus
          value={text}
          disabled={saving}
          aria-label='Title'
          aria-invalid={emptyRefused || error !== null}
          data-testid='glob-title-input'
          className='block min-w-0 flex-1 resize-none overflow-hidden rounded border bg-card px-1 text-xl leading-snug font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring'
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
