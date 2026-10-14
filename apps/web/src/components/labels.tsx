import { LABEL_NAMES, machine } from '@slop/core';
import type { ChecklistItem, LabelCommand, LabelName, LabelState } from '@slop/core';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tip';
import type { GlobView } from '@/lib/api';
import { approveHold } from '@/lib/human-steps';
import { cn } from '@/lib/utils';

const LABEL_TITLES: Record<LabelName, string> = {
  FR: 'Functional review',
  CR: 'Code review',
  QA: 'QA',
};

/** Resolves true when the command went through (failures are reported by the board). */
export type ReviewLabel = (label: LabelName, command: LabelCommand) => Promise<boolean>;

/** Required: outlined brown. Added (items to work through): dark red. Approved: LCD green. */
const chip = (state: LabelState) =>
  state === 'approved'
    ? 'border-foreground bg-lcd text-lcd-foreground'
    : state === 'added'
      ? 'border-red bg-red/30 text-foreground'
      : 'border-required-border bg-transparent text-required';

const presentLabels = (glob: GlobView): LabelName[] =>
  LABEL_NAMES.filter((name) => glob.labels[name] !== undefined);

/** A server from before checklists sends none, so they're treated as optional here. */
const itemsOf = (glob: GlobView, name: LabelName): readonly ChecklistItem[] =>
  (glob.checklists as GlobView['checklists'] | undefined)?.[name] ?? [];

const stateText = (state: LabelState, items: readonly ChecklistItem[]): string => {
  const done = items.filter((i) => i.done).length;
  if (state === 'added') return `Items added · ${done} of ${items.length} done`;
  if (state === 'approved') return 'Approved';
  return items.length === 0
    ? 'Waiting for review'
    : `Resubmitted · ${done} of ${items.length} done`;
};

const CHIP_TIPS: Record<LabelState, string> = {
  required: 'waiting for the reviewer',
  added: "items added: the developer's turn",
  approved: 'approved',
};

const Chip = ({ name, state }: { name: LabelName; state: LabelState }) => (
  <Tip text={`${LABEL_TITLES[name]}: ${CHIP_TIPS[state]}`}>
    <span className={cn('rounded-sm border px-1.5 font-mono text-[10px] font-semibold', chip(state))}>
      {name}
    </span>
  </Tip>
);

/** The chips alone, for places that show the review elsewhere (the glob view's header). */
export const LabelChips = ({ glob }: { glob: GlobView }) => {
  const present = presentLabels(glob);
  if (present.length === 0) return null;
  return (
    <span className="flex gap-1" aria-label="Sign-off labels">
      {present.map((name) => (
        <Chip key={name} name={name} state={glob.labels[name] ?? 'required'} />
      ))}
    </span>
  );
};

/**
 * FR/CR/QA chips on the card; clicking opens a compact status view with a quick Approve or
 * Re-open, without opening the glob. Checklists are worked in the glob view.
 */
export const LabelPopover = ({
  glob,
  onReview,
  onOpenReview,
}: {
  glob: GlobView;
  onReview: ReviewLabel;
  /** Opens the sign-off section in the glob view, at one label's checklist when given. */
  onOpenReview: (label?: LabelName) => void;
}) => {
  const present = presentLabels(glob);
  const hold = approveHold(glob);
  if (present.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        className="flex gap-1"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Sign-off labels"
      >
        {present.map((name) => (
          <Chip key={name} name={name} state={glob.labels[name] ?? 'required'} />
        ))}
      </PopoverTrigger>
      <PopoverContent className="w-80" onClick={(e) => e.stopPropagation()}>
        <div className="grid gap-2">
          {present.map((name) => {
            const state = glob.labels[name] ?? 'required';
            const items = itemsOf(glob, name);
            return (
              <div key={name} className="flex items-center justify-between gap-3 text-sm">
                <span className="grid">
                  <span className="font-semibold">{name}</span>
                  {(state !== 'required' || items.length > 0) && (
                    <span className="text-xs text-muted-foreground">{stateText(state, items)}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => onOpenReview(name)}>
                    Open review
                  </Button>
                  {state === 'approved' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void onReview(name, { kind: 'reopen' })}
                    >
                      Re-open
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={hold !== null}
                      title={hold ?? undefined}
                      onClick={() => void onReview(name, { kind: 'approve' })}
                    >
                      Approve
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
          <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => onOpenReview()}>
            Open review checklist
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

const ItemList = ({
  items,
  onTick,
  disabled,
}: {
  items: readonly ChecklistItem[];
  /** Absent when the list is read-only. */
  onTick?: (item: ChecklistItem, done: boolean) => void;
  disabled: boolean;
}) => (
  <ul className="grid gap-1">
    {items.map((item) => (
      <li key={item.id}>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 accent-[var(--signal)]"
            checked={item.done}
            disabled={onTick === undefined || disabled}
            onChange={(e) => onTick?.(item, e.target.checked)}
          />
          <span
            className={cn('whitespace-pre-wrap', item.done && 'text-muted-foreground line-through')}
          >
            {item.text}
            <span className="block text-[11px] text-muted-foreground no-underline">
              {item.addedBy}
              {item.doneBy !== null && ` · ticked by ${item.doneBy}`}
            </span>
          </span>
        </label>
      </li>
    ))}
  </ul>
);

const LabelReview = ({
  glob,
  name,
  onReview,
  open,
}: {
  glob: GlobView;
  name: LabelName;
  onReview: ReviewLabel;
  open: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  // Once per navigation: `open` only changes with the link, not on the live refreshes.
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  const state = glob.labels[name] ?? 'required';
  const items = itemsOf(glob, name);
  const [drafts, setDrafts] = useState<string[]>(['']);
  const [busy, setBusy] = useState(false);
  const signedOff = glob.status === 'signed_off';
  const hold = approveHold(glob);

  const act = async (command: LabelCommand): Promise<boolean> => {
    setBusy(true);
    try {
      return await onReview(name, command);
    } finally {
      setBusy(false);
    }
  };
  const texts = drafts.map((d) => d.trim()).filter((d) => d !== '');

  return (
    <div
      ref={ref}
      className={cn('grid gap-2 rounded-md border p-3', open && 'border-[var(--signal)]')}
      data-testid={`review-${name}`}
    >
      <div className="flex items-center gap-2 text-sm">
        <Chip name={name} state={state} />
        <span className="font-semibold">{LABEL_TITLES[name]}</span>
        <span className="ml-auto text-xs text-muted-foreground">{stateText(state, items)}</span>
      </div>

      {items.length > 0 && (
        <ItemList
          items={items}
          disabled={busy}
          onTick={
            state === 'added' && !signedOff
              ? (item, done) => void act({ kind: 'tick', itemId: item.id, done })
              : undefined
          }
        />
      )}

      {state === 'required' && (
        <div className="grid gap-1.5">
          {drafts.map((draft, i) => (
            <div key={i} className="flex gap-1.5">
              <Input
                aria-label={`${name} item ${i + 1}`}
                placeholder="What needs doing?"
                value={draft}
                maxLength={machine.MAX_CHECKLIST_ITEM_LENGTH}
                onChange={(e) => setDrafts(drafts.map((d, j) => (j === i ? e.target.value : d)))}
              />
              {drafts.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${name} item ${i + 1}`}
                  onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}
                >
                  ×
                </Button>
              )}
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            onClick={() => setDrafts([...drafts, ''])}
          >
            + Add another
          </Button>
        </div>
      )}

      {hold !== null && state !== 'approved' && (
        <p className="text-xs text-muted-foreground" data-testid={`approve-hold-${name}`}>
          {hold}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {state === 'required' && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || texts.length === 0}
            onClick={() =>
              void act({ kind: 'submit_items', items: texts }).then((ok) => {
                if (ok) setDrafts(['']);
              })
            }
          >
            Submit items
          </Button>
        )}
        {state === 'added' && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void act({ kind: 'resubmit' })}
          >
            Resubmit for review
          </Button>
        )}
        {state === 'approved' ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void act({ kind: 'reopen' })}
          >
            Re-open review
          </Button>
        ) : (
          <Button size="sm" disabled={busy || hold !== null} title={hold ?? undefined} onClick={() => void act({ kind: 'approve' })}>
            Approve
          </Button>
        )}
      </div>
    </div>
  );
};

/**
 * The glob view's sign-off section: per label, the reviewer adds items or approves, the developer
 * ticks items and resubmits. Approved labels and signed-off globs show their items read-only.
 */
export const LabelReviews = ({
  glob,
  onReview,
  openLabel = null,
}: {
  glob: GlobView;
  onReview: ReviewLabel;
  openLabel?: LabelName | null;
}) => {
  const present = presentLabels(glob);
  if (present.length === 0) return null;
  return (
    <section className="grid gap-2" aria-label="Sign-off reviews" id={`reviews-${glob.id}`}>
      <h3 className="text-xs font-semibold text-muted-foreground">Sign-off</h3>
      {present.map((name) => (
        <LabelReview
          key={`${glob.id}-${name}`}
          glob={glob}
          name={name}
          onReview={onReview}
          open={openLabel === name}
        />
      ))}
    </section>
  );
};
