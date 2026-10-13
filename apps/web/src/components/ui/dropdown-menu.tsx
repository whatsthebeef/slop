import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;

export const DropdownMenuContent = ({
  className,
  ...props
}: ComponentProps<typeof DropdownPrimitive.Content>) => (
  <DropdownPrimitive.Portal>
    <DropdownPrimitive.Content
      align="start"
      sideOffset={6}
      className={cn('z-50 min-w-64 max-w-80 rounded-md border bg-card p-1 shadow-lg', className)}
      {...props}
    />
  </DropdownPrimitive.Portal>
);

export const DropdownMenuItem = ({
  className,
  ...props
}: ComponentProps<typeof DropdownPrimitive.Item>) => (
  <DropdownPrimitive.Item
    className={cn(
      'flex cursor-pointer flex-col gap-0.5 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted',
      className,
    )}
    {...props}
  />
);
