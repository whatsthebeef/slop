import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = ({
  className,
  children,
  title,
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> & { title: ReactNode }) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className='fixed inset-0 z-40 bg-black/40' />
    <DialogPrimitive.Content
      className={cn(
        'fixed top-[8vh] left-1/2 z-50 max-h-[84vh] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-y-auto rounded-lg border bg-card p-5 shadow-xl',
        className,
      )}
      aria-describedby={undefined}
      {...props}
    >
      <div className='mb-4 flex items-start justify-between gap-4'>
        <DialogPrimitive.Title className='text-base font-semibold'>{title}</DialogPrimitive.Title>
        <DialogPrimitive.Close className='rounded p-1 hover:bg-muted' aria-label='Close'>
          <X className='h-4 w-4' />
        </DialogPrimitive.Close>
      </div>
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
);
