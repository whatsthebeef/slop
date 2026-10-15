import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { readGroupOpen, SETTINGS_GROUPS, writeGroupOpen } from '@/lib/settings-groups';
import type { SettingsGroupId } from '@/lib/settings-groups';

/**
 * One collapsible group of the settings page. Its open state is remembered for this viewer; `forceOpen` (a link into the
 * group) opens it without changing what is remembered. A closed group renders none of its content.
 */
export const SettingsGroup = ({ id, forceOpen = false, children }: { id: SettingsGroupId; forceOpen?: boolean; children: ReactNode }) => {
  const { title, blurb } = SETTINGS_GROUPS[id];
  const [open, setOpen] = useState(() => readGroupOpen(id));
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  const bodyId = `settings-${id}-body`;
  return (
    <section className='grid gap-3 rounded-md border bg-card p-4' data-testid={`settings-group-${id}`}>
      <h2 className='text-sm font-semibold'>
        <button
          type='button'
          className='flex w-full items-center gap-1 text-left'
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid={`settings-group-${id}-toggle`}
          onClick={() => {
            writeGroupOpen(id, !open);
            setOpen(!open);
          }}
        >
          {open ? <ChevronDown aria-hidden className='size-4' /> : <ChevronRight aria-hidden className='size-4' />}
          {title}
        </button>
      </h2>
      <p className='text-xs text-muted-foreground'>{blurb}</p>
      {open && (
        <div id={bodyId} className='grid gap-4'>
          {children}
        </div>
      )}
    </section>
  );
};

/** A sub-heading inside a group, with its one-line explanation. */
export const SettingBlock = ({ title, hint, testId, children }: { title: string; hint: string; testId?: string; children: ReactNode }) => (
  <div className='grid gap-2' data-testid={testId}>
    <div className='grid gap-0.5'>
      <h3 className='text-xs font-semibold'>{title}</h3>
      <p className='text-xs text-muted-foreground'>{hint}</p>
    </div>
    {children}
  </div>
);

/**
 * A labelled control with its one-line explanation under the label (visible text, not a tooltip). The control gets the
 * id and `aria-describedby` through `children`.
 */
export const Field = ({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint: string;
  className?: string;
  children: (props: { id: string; 'aria-describedby': string }) => ReactElement;
}) => {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={`grid gap-1 ${className ?? ''}`}>
      <label htmlFor={id} className='text-xs font-medium text-muted-foreground'>
        {label}
      </label>
      <p id={hintId} className='text-xs text-muted-foreground'>
        {hint}
      </p>
      {children({ id, 'aria-describedby': hintId })}
    </div>
  );
};

/** A checkbox with its label and a one-line explanation under it. */
export const CheckField = ({
  label,
  hint,
  checked,
  disabled,
  onChange,
  testId,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}) => {
  const hintId = `${useId()}-hint`;
  return (
    <div className='grid gap-0.5'>
      <label className='flex items-center gap-2 text-sm'>
        <input
          type='checkbox'
          aria-describedby={hintId}
          disabled={disabled}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          data-testid={testId}
        />
        {label}
      </label>
      <p id={hintId} className='pl-6 text-xs text-muted-foreground'>
        {hint}
      </p>
    </div>
  );
};

/** The button that saves the form (every group that edits shares one save). Admins only. */
export const SaveButton = ({ visible, pending, invalid, onSave }: { visible: boolean; pending: boolean; invalid: boolean; onSave: () => void }) =>
  visible ? (
    <div className='flex items-center gap-2'>
      <Button size='sm' disabled={pending || invalid} onClick={onSave}>
        Save settings
      </Button>
      <span className='text-xs text-muted-foreground'>Saves the changes in every group above and below.</span>
    </div>
  ) : null;
