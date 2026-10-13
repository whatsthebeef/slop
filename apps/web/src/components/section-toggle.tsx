import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

/** A collapsible section's heading: a chevron and the label as one toggle button, with `aria-expanded`. */
export const SectionToggle = ({ open, onToggle, testId, children }: { open: boolean; onToggle: () => void; testId: string; children: ReactNode }) => (
  <h3 className='text-xs font-semibold text-muted-foreground'>
    <button type='button' className='flex items-center gap-1' aria-expanded={open} onClick={onToggle} data-testid={testId}>
      {open ? <ChevronDown aria-hidden className='size-3.5' /> : <ChevronRight aria-hidden className='size-3.5' />}
      {children}
    </button>
  </h3>
);
