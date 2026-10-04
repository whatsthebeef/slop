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

export const Select = ({ className, ...props }: ComponentProps<'select'>) => (
  <select className={cn(field, 'h-9', className)} {...props} />
);

export const Label = ({ className, ...props }: ComponentProps<'label'>) => (
  <label className={cn('grid gap-1 text-xs font-medium text-muted-foreground', className)} {...props} />
);
