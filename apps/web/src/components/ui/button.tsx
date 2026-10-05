import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md border text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'press border-primary bg-primary font-semibold text-primary-foreground hover:opacity-90',
        outline: 'press border-foreground/70 bg-card hover:bg-muted',
        ghost: 'border-transparent hover:bg-muted',
        destructive: 'press border-destructive bg-destructive font-semibold text-card hover:opacity-90',
        selected: 'border-foreground bg-lcd text-lcd-foreground',
      },
      size: { default: 'h-9 px-3', sm: 'h-7 px-2 text-xs', icon: 'h-8 w-8' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export const Button = ({
  className,
  variant,
  size,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) => (
  <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
);
