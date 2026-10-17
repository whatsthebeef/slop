import { LABEL_NAMES, machine } from '@slop/core';
import type { ChecklistItem, LabelCommand, LabelName, LabelState } from '@slop/core';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tip';
import type { GlobView } from '@/lib/api';
import { approveHold, reviewOpen } from '@/lib/human-steps';
import { cn } from '@/lib/utils';
import { Block } from './glob-view/block';

const LABEL_TITLES: Record<LabelName, string> = {
  FR: 'Functional review',
  CR: 'Code review',
  QA: 'QA',
};

/** Resolves true when the command went through (failures are reported by the board). */
export type ReviewLabel = (label: LabelName, command: LabelCommand) => Promise<boolean>;

const presentLabels = (glob: GlobView): LabelName[] =>
  reviewOpen(glob) ? LABEL_NAMES.filter((name) => glob.labels[name] !== undefined) : [];

/** A server from before checklists sends none, so they're treated as optional here. */
const allItemsOf = (glob: GlobView, name: LabelName): readonly ChecklistItem[] =>
  (glob.checklists as GlobView['checklists'] | undefined)?.[name] ?? [];

/** The sent items: the reviewer's unsent drafts are not part of the review yet. */
const itemsOf = (glob: GlobView, name: LabelName): readonly ChecklistItem[] =>
  allItemsOf(glob, name).filter((i) => i.draft !== true);

const draftsOf = (glob: GlobView, name: LabelName): readonly ChecklistItem[] =>
  allItemsOf(glob, name).filter((i) => i.draft === true);

/** What approving now would leave behind: unticked items to work through, and drafts that would be discarded. */
const openCounts = (
  glob: GlobView,
  name: LabelName,
  state: LabelState,
): { open: number; drafts: number } => {
  const drafts = state === 'required' ? draftsOf(glob, name).length : 0;
  const unticked = state === 'approved' ? 0 : itemsOf(glob, name).filter((i) => !i.done).length;
  return { open: unticked + drafts, drafts };
};

/** "Approve anyway" asks first; hosts keep the confirmation outside any popover so it outlives it. */
const ApproveConfirm = ({
  label,
  counts,
  onCancel,
  onConfirm,
}: {
  label: LabelName | null;
  counts: { open: number; drafts: number };
  onCancel: () => void;
  onConfirm: () => void;
}) => (
  // React events bubble through the dialog's portal to the host: on the card that would open the glob or start a drag.
  <div
    className="contents"
    onClick={(e) => e.stopPropagation()}
    onPointerDown={(e) => e.stopPropagation()}
  >
    <Dialog open={label !== null && counts.open > 0} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent title={`Approve ${label ?? ''}?`}>
        <div className="grid gap-3 text-sm">
          <p>
            {counts.open === 1 ? '1 item is' : `${counts.open} items are`} still open. Approve
            anyway?
            {counts.drafts > 0 && ' Unsent drafts will be discarded.'}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="outline" size="sm" onClick={onConfirm}>
              Approve anyway
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
);

const stateText = (state: LabelState, items: readonly ChecklistItem[]): string => {
  const done = items.filter((i) => i.done).length;
  if (state === 'added') return `Items added · ${done} of ${items.length} done`;
  if (state === 'approved') return 'Approved';
  return items.length === 0
    ? 'Waiting for review'
    : `Resubmitted · ${done} of ${items.length} done`;
};

/** Every state a label's text can take in the popover, so its column can reserve room for the widest. Without items only "Approved" has text, so nothing wider is reserved. */
const RESERVED_STATES: readonly LabelState[] = ['required', 'added', 'approved'];

const CHIP_TIPS: Record<LabelState, string> = {
  required: 'waiting for the reviewer',
  added: "items added: the developer's turn",
  approved: 'approved',
};

/** Whether a label still has a sent item to work through, whatever its stored state. */
const hasOutstanding = (glob: GlobView, name: LabelName): boolean =>
  glob.labels[name] !== 'approved' && itemsOf(glob, name).some((i) => !i.done);

/** Approved: LCD green. Any open item: filled deep red, white text. Otherwise required: outlined brown. */
const chip = (state: LabelState, outstanding: boolean) =>
  state === 'approved'
    ? 'border-foreground bg-lcd text-lcd-foreground'
    : outstanding
      ? 'border-outstanding bg-outstanding text-outstanding-foreground'
      : 'border-required-border bg-transparent text-required';

const Chip = ({ glob, name }: { glob: GlobView; name: LabelName }) => {
  const state = glob.labels[name] ?? 'required';
  const outstanding = hasOutstanding(glob, name);
  return (
    <Tip text={`${LABEL_TITLES[name]}: ${outstanding ? CHIP_TIPS.added : CHIP_TIPS[state]}`}>
      <span
        data-outstanding={outstanding || undefined}
        className={cn(
          'rounded-sm border px-1.5 font-mono text-[10px] font-semibold',
          chip(state, outstanding),
        )}
      >
        {name}
      </span>
    </Tip>
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
  /** Absent on a read-only card: the popover then only links to the review. */
  onReview?: ReviewLabel;
  /** Opens the sign-off section in the glob view, at one label's checklist when given. */
  onOpenReview: (label?: LabelName) => void;
}) => {
  const present = presentLabels(glob);
  const hold = approveHold(glob);
  const [confirming, setConfirming] = useState<LabelName | null>(null);
  const confirmingCounts =
    confirming === null
      ? { open: 0, drafts: 0 }
      : openCounts(glob, confirming, glob.labels[confirming] ?? 'required');
  // The dialog closes when nothing is open any more; forget the pending confirmation so later items don't reopen it.
  useEffect(() => {
    if (confirming !== null && confirmingCounts.open === 0) setConfirming(null);
  }, [confirming, confirmingCounts.open]);
  if (present.length === 0) return null;
  return (
    <>
      <Popover>
        <PopoverTrigger
          className="flex gap-1"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Sign-off labels"
        >
          {present.map((name) => (
            <Chip key={name} glob={glob} name={name} />
          ))}
        </PopoverTrigger>
        <PopoverContent
          className="w-auto min-w-max max-w-[20rem] p-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="grid gap-1">
            {present.map((name) => {
              const state = glob.labels[name] ?? 'required';
              const items = itemsOf(glob, name);
              const { open } = openCounts(glob, name, state);
              return (
                <div key={name} className="flex items-center justify-between gap-1.5 text-sm">
                  <span className="flex items-baseline gap-1.5">
                    <span className="font-semibold">{name}</span>
                    {/* Every state's text shares one cell, so the column is as wide as the widest and approving doesn't resize the popover. */}
                    <span className="grid text-xs text-muted-foreground">
                      {RESERVED_STATES.filter((s) => s === 'approved' || items.length > 0).map(
                        (s) => (
                          <span
                            key={s}
                            data-reserved-state={s}
                            aria-hidden={s !== state || undefined}
                            className={cn('col-start-1 row-start-1', s !== state && 'invisible')}
                          >
                            {stateText(s, items)}
                          </span>
                        ),
                      )}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => onOpenReview(name)}>
                      Open review
                    </Button>
                    {onReview === undefined ? null : (
                      <span className="grid">
                        {/* The widest action ("Approve anyway") is kept in the cell, hidden, whichever button shows. */}
                        <span
                          aria-hidden
                          className="invisible col-start-1 row-start-1 px-3 text-sm"
                          data-reserved-action
                        >
                          Approve anyway
                        </span>
                        {state === 'approved' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="col-start-1 row-start-1"
                            onClick={() => void onReview(name, { kind: 'reopen' })}
                          >
                            Re-open
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="col-start-1 row-start-1"
                            disabled={hold !== null}
                            title={hold ?? undefined}
                            onClick={() =>
                              open > 0
                                ? setConfirming(name)
                                : void onReview(name, { kind: 'approve' })
                            }
                          >
                            {open > 0 ? 'Approve anyway' : 'Approve'}
                          </Button>
                        )}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 justify-self-start px-1 text-xs"
              onClick={() => onOpenReview()}
            >
              Open review checklist
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <ApproveConfirm
        label={confirming}
        counts={confirmingCounts}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming !== null) void onReview?.(confirming, { kind: 'approve' });
          setConfirming(null);
        }}
      />
    </>
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

/** One saved draft: read-only with a ✕; clicking the text edits it (Enter or blur saves, Escape cancels). */
const DraftRow = ({
  item,
  name,
  index,
  disabled,
  onSave,
  onRemove,
}: {
  item: ChecklistItem;
  name: LabelName;
  index: number;
  disabled: boolean;
  onSave: (text: string) => void;
  onRemove: () => void;
}) => {
  const [text, setText] = useState<string | null>(null);
  // Enter, Escape and the blur they cause settle an edit once.
  const settled = useRef(false);
  const settle = (save: boolean) => {
    // A request is in flight: keep the edit open rather than send a second command with a stale version.
    if (settled.current || (save && disabled)) return;
    settled.current = true;
    const next = (text ?? '').trim();
    setText(null);
    if (save && next !== '' && next !== item.text) onSave(next);
  };
  return (
    <div className="flex items-start gap-1.5">
      {text === null ? (
        <button
          type="button"
          className="min-w-0 flex-1 whitespace-pre-wrap rounded-md px-3 py-1.5 text-left text-sm hover:bg-muted"
          disabled={disabled}
          onClick={() => {
            settled.current = false;
            setText(item.text);
          }}
        >
          {item.text}
        </button>
      ) : (
        <Input
          autoFocus
          aria-label={`Edit ${name} item ${index}`}
          value={text}
          maxLength={machine.MAX_CHECKLIST_ITEM_LENGTH}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => settle(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') settle(true);
            else if (e.key === 'Escape') settle(false);
          }}
        />
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label={`Remove ${name} item ${index}`}
        disabled={disabled}
        // Keep focus in the edited input: its blur would save and disable this button before the click lands.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRemove}
      >
        ×
      </Button>
    </div>
  );
};

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
  // The saved drafts live on the server; only the field being typed in is local.
  const drafts = draftsOf(glob, name);
  const [typed, setTyped] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const signedOff = glob.status === 'signed_off';
  const hold = approveHold(glob);
  const counts = openCounts(glob, name, state);
  // The dialog closes when nothing is open any more; forget the pending confirmation so later items don't reopen it.
  useEffect(() => {
    if (confirming && counts.open === 0) setConfirming(false);
  }, [confirming, counts.open]);

  const act = async (command: LabelCommand): Promise<boolean> => {
    setBusy(true);
    try {
      return await onReview(name, command);
    } finally {
      setBusy(false);
    }
  };
  const text = typed.trim();
  /** Saves the typed text as a draft and keeps an empty, focused field ready for the next one. */
  const saveTyped = async () => {
    if (text === '' || busy) return;
    if (await act({ kind: 'save_draft_item', text })) setTyped('');
    field.current?.focus();
  };
  const toSend = drafts.length + (text === '' ? 0 : 1);

  return (
    <div
      ref={ref}
      className={cn('grid gap-2 rounded-md border p-3', open && 'border-[var(--signal)]')}
      data-testid={`review-${name}`}
    >
      <div className="flex items-center gap-2 text-sm">
        <Chip glob={glob} name={name} />
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
            <DraftRow
              key={draft.id}
              item={draft}
              name={name}
              index={i + 1}
              disabled={busy}
              onSave={(next) => void act({ kind: 'save_draft_item', text: next, itemId: draft.id })}
              onRemove={() => void act({ kind: 'remove_draft_item', itemId: draft.id })}
            />
          ))}
          <Input
            ref={field}
            autoFocus
            aria-label={`${name} item ${drafts.length + 1}`}
            placeholder="What needs doing?"
            value={typed}
            maxLength={machine.MAX_CHECKLIST_ITEM_LENGTH}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              void saveTyped();
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            onClick={() => void saveTyped()}
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
            disabled={busy || toSend === 0}
            onClick={() =>
              // The typed text goes with the drafts in one command, so a second request never carries a stale version.
              void act(
                text === '' ? { kind: 'send_items' } : { kind: 'submit_items', items: [text] },
              ).then((ok) => {
                if (ok) setTyped('');
              })
            }
          >
            {toSend === 1 ? 'Send 1 item' : `Send ${toSend} items`}
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
          <Button
            variant="outline"
            size="sm"
            disabled={busy || hold !== null}
            title={hold ?? undefined}
            onClick={() => (counts.open > 0 ? setConfirming(true) : void act({ kind: 'approve' }))}
          >
            {counts.open > 0 ? 'Approve anyway' : 'Approve'}
          </Button>
        )}
      </div>
      <ApproveConfirm
        label={confirming ? name : null}
        counts={counts}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void act({ kind: 'approve' });
        }}
      />
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
    <Block tone="person" actor="human" id={`reviews-${glob.id}`} testId="label-reviews" title="Sign-off">
      {present.map((name) => (
        <LabelReview
          key={`${glob.id}-${name}`}
          glob={glob}
          name={name}
          onReview={onReview}
          open={openLabel === name}
        />
      ))}
    </Block>
  );
};
