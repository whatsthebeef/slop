import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const field =
  'w-full rounded-md border bg-card px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

export const Input = ({ className, ...props }: ComponentProps<'input'>) => (
  <input className={cn(field, 'h-9', className)} {...props} />
);

export const Textarea = ({ className, ...props }: ComponentProps<'textarea'>) => (
  <textarea className={cn(field, 'min-h-20', className)} {...props} />
);

/** The native chevron sits against the edge, so draw our own with 0.75rem clear of it. */
export const Select = ({ className, ...props }: ComponentProps<'select'>) => (
  <span className={cn('relative block', className)}>
    <select className={cn(field, 'h-9 appearance-none pr-9', className)} {...props} />
    <ChevronDown aria-hidden className='pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground' />
  </span>
);

export const Label = ({ className, ...props }: ComponentProps<'label'>) => (
  <label className={cn('grid gap-1 text-xs font-medium text-muted-foreground', className)} {...props} />
);
