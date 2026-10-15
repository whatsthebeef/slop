import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { EditFailure } from '@slop/core';
import { HumanIcon, MachineIcon } from '@/components/actor-icons';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tip';
import type { TypeOption } from '@/lib/type-change';
import { cn } from '@/lib/utils';

/**
 * The glob's type as a chip that opens a popover of the three types. Choosing one says what follows first;
 * a type that can't be chosen now is greyed out with the reason.
 */
export const TypePopover = ({
  type,
  options,
  busy,
  failure,
  onChange,
  compact = false,
}: {
  readonly type: string;
  readonly options: TypeOption[];
  readonly busy: boolean;
  readonly failure: EditFailure | null;
  readonly onChange: (option: TypeOption) => Promise<void>;
  /** The top bar's style: no border or box, text-sm, so it reads as part of the line. */
  readonly compact?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState<TypeOption | null>(null);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setChoosing(null);
      }}
    >
      <Tip text={`This is a ${type}; open to change it`}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 rounded hover:bg-muted',
              compact ? 'px-1 text-sm font-medium' : 'border px-2 py-0.5 text-xs',
            )}
            data-testid="glob-type"
          >
            {type}
            <ChevronDown className="size-3" aria-hidden />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="start" className="grid w-80 gap-1 p-2" data-testid="type-popover">
        {options.map((o) => {
          const unavailable = !o.current && o.via === null;
          return (
            <button
              key={o.to}
              type="button"
              disabled={unavailable || busy}
              aria-current={o.current ? 'true' : undefined}
              data-testid={`type-${o.to}`}
              className={cn(
                'grid gap-0.5 rounded px-2 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                o.current && 'bg-muted',
              )}
              onClick={() => setChoosing(o.current ? null : o)}
            >
              <span className="flex items-center gap-1.5 font-medium">
                {o.machine && <MachineIcon decorative />}
                {o.human && <HumanIcon decorative />}
                {o.to}
                {o.current && <span className="font-normal text-muted-foreground">(current)</span>}
              </span>
              <span className="text-muted-foreground">{o.description}</span>
              {unavailable && o.reason !== null && (
                <span className="text-muted-foreground" data-testid={`type-${o.to}-reason`}>
                  {o.reason}
                </span>
              )}
            </button>
          );
        })}
        {choosing !== null && (
          <div role="alert" className="grid gap-2 rounded border border-amber/60 bg-amber/10 p-2 text-xs">
            <span data-testid="type-says">
              Make it a {choosing.to}? {choosing.consequence}
            </span>
            <span className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setChoosing(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy}
                data-testid="confirm-type"
                onClick={() => {
                  setChoosing(null);
                  setOpen(false);
                  void onChange(choosing);
                }}
              >
                Make it a {choosing.to}
              </Button>
            </span>
          </div>
        )}
        {failure !== null && (
          <p role="alert" className="text-xs text-red" data-testid="type-failure">
            {failure.message}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
};
