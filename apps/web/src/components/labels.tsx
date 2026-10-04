import { LABEL_NAMES } from '@slop/core';
import type { LabelName, LabelState } from '@slop/core';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { GlobView } from '@/lib/api';
import { cn } from '@/lib/utils';

const LABEL_TITLES: Record<LabelName, string> = { FR: 'Functional review', CR: 'Code review', QA: 'QA' };

const chip = (state: LabelState) =>
  state === 'added'
    ? 'bg-emerald-600 text-white border-emerald-600'
    : 'bg-transparent text-amber-700 dark:text-amber-300 border-amber-500';

/** FR/CR/QA chips; clicking opens switches without opening the glob. */
export const LabelSwitches = ({
  glob,
  onSwitch,
}: {
  glob: GlobView;
  onSwitch: (label: LabelName, state: LabelState) => void;
}) => {
  const present = LABEL_NAMES.filter((name) => glob.labels[name] !== undefined);
  if (present.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        className='flex gap-1'
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label='Sign-off labels'
      >
        {present.map((name) => {
          const state = glob.labels[name] ?? 'required';
          return (
            <span key={name} className={cn('rounded border px-1.5 text-[11px] font-semibold', chip(state))}>
              {name}
            </span>
          );
        })}
      </PopoverTrigger>
      <PopoverContent className='w-64' onClick={(e) => e.stopPropagation()}>
        <div className='grid gap-2'>
          {present.map((name) => {
            const state = glob.labels[name] ?? 'required';
            const added = state === 'added';
            return (
              <label key={name} className='flex items-center justify-between gap-3 text-sm'>
                <span>
                  <span className='font-semibold'>{name}</span>{' '}
                  <span className='text-muted-foreground'>{LABEL_TITLES[name]}</span>
                </span>
                <button
                  type='button'
                  role='switch'
                  aria-checked={added}
                  onClick={() => onSwitch(name, added ? 'required' : 'added')}
                  className={cn(
                    'relative h-6 w-11 shrink-0 rounded-full transition-colors',
                    added ? 'bg-emerald-600' : 'bg-amber-500',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
                      added ? 'translate-x-5.5' : 'translate-x-0.5',
                    )}
                  />
                </button>
              </label>
            );
          })}
          <p className='text-xs text-muted-foreground'>Amber: required. Green: added.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
};
