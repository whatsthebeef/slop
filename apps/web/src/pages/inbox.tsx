import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router';
import type { BoardShellContext } from '@/components/board-shell';
import { PasteIntoInbox } from '@/components/paste-into-inbox';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Select } from '@/components/ui/input';
import { api, RequestError } from '@/lib/api';
import type { GlobView, InboxItemView } from '@/lib/api';
import { attachableGlobs, pendingCount, processingNote, visibleItems } from '@/lib/inbox';
import { globsKey, inboxKey, useLiveInbox } from '@/lib/live';
import { cn } from '@/lib/utils';
import { useToast } from '@/toast';

const message = (error: unknown) =>
  error instanceof RequestError ? error.body.message : 'Something went wrong';
const day = (iso: string) => iso.slice(0, 10);
/** Hints are lost in hidden tabs, so an item being summarised is also polled. */
const POLL_MS = 15_000;

const globLink = (boardId: number, globId: string) =>
  `/boards/${String(boardId)}?glob=${encodeURIComponent(globId)}`;

/** Attach to the suggested globs (ticked) and any other open glob of the board. */
const AttachDialog = ({
  boardId,
  item,
  globs,
  initial,
  open,
  onOpenChange,
  onDone,
}: {
  boardId: number;
  item: InboxItemView;
  globs: readonly GlobView[];
  /** The globs ticked when it opens. */
  initial: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) => {
  const toast = useToast();
  const suggested = item.suggestions ?? [];
  const [picked, setPicked] = useState<string[]>([...initial]);
  const [extra, setExtra] = useState('');
  const choices = attachableGlobs(globs, item).filter((g) => !picked.includes(g.id));
  const attach = useMutation({
    mutationFn: () => api.attachInbox(boardId, item.id, extra === '' ? picked : [...picked, extra]),
    onSuccess: () => {
      toast('Attached');
      onDone();
      onOpenChange(false);
    },
    onError: (e) => toast(message(e)),
  });
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const count = picked.length + (extra === '' ? 0 : 1);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Attach to globs">
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            It appears on each glob as an attachment, in its context, and its decisions are read
            from it.
          </p>
          {suggested.map((s) => (
            <label key={s.globId} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.includes(s.globId)}
                onChange={() => toggle(s.globId)}
              />
              <span>
                <span className="font-mono text-xs">{s.globId}</span> {s.title}
                <span className="block text-xs text-muted-foreground">{s.reason}</span>
              </span>
            </label>
          ))}
          <Select
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            aria-label="Another glob"
          >
            <option value="">Another glob…</option>
            {choices.map((g) => (
              <option key={g.id} value={g.id}>
                {g.id} {g.title}
              </option>
            ))}
          </Select>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={count === 0 || attach.isPending} onClick={() => attach.mutate()}>
              Attach to {count} {count === 1 ? 'glob' : 'globs'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const Card = ({
  boardId,
  item,
  globs,
  highlighted,
  onChanged,
}: {
  boardId: number;
  item: InboxItemView;
  globs: readonly GlobView[];
  highlighted: boolean;
  onChanged: () => void;
}) => {
  const toast = useToast();
  const [showText, setShowText] = useState(highlighted);
  // The globs ticked in the attach dialog while it is open.
  const [attaching, setAttaching] = useState<readonly string[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const detail = useQuery({
    queryKey: [...inboxKey(boardId), item.id],
    queryFn: () => api.inboxItem(boardId, item.id),
    enabled: showText,
  });
  const settle = useMutation({
    mutationFn: (action: 'keep' | 'discard') =>
      action === 'keep' ? api.keepInbox(boardId, item.id) : api.discardInbox(boardId, item.id),
    onSuccess: onChanged,
    onError: (e) => toast(message(e)),
  });
  // The glob's attachment links here: bring the item into view.
  useEffect(() => {
    if (highlighted)
      document.getElementById(`inbox-${String(item.id)}`)?.scrollIntoView({ block: 'center' });
  }, [highlighted, item.id]);
  const note = processingNote(item);
  const suggestions = item.suggestions ?? [];
  const attached = item.attachedTo ?? [];
  const source =
    item.sourceLabel === undefined || item.sourceLabel === ''
      ? 'Paste'
      : `Paste · ${item.sourceLabel}`;
  return (
    <li
      id={`inbox-${String(item.id)}`}
      data-testid="inbox-item"
      className={cn('grid gap-2 rounded-md border bg-card p-3', highlighted && 'ring-2 ring-ring')}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* Titles and summaries come from outside (pasted text, a model): plain text only. */}
        <h2 className="text-sm font-semibold break-words">{item.title}</h2>
        <span className="text-xs text-muted-foreground">
          {source} · {day(item.occurredAt)}
        </span>
        {item.status !== 'new' && (
          <span className="rounded-full bg-muted px-2 text-xs">{item.status}</span>
        )}
      </div>
      {item.summary !== undefined && item.summary !== null ? (
        <p className="text-sm whitespace-pre-wrap break-words">{item.summary}</p>
      ) : (
        <>
          {item.excerpt !== undefined && item.excerpt !== '' && (
            <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">
              {item.excerpt}
            </p>
          )}
          {note !== null && <p className="text-xs text-muted-foreground">{note}</p>}
        </>
      )}
      {suggestions.length > 0 && (
        <ul className="grid gap-1" aria-label="Suggested globs">
          {suggestions.map((s) => (
            <li key={s.globId} className="flex flex-wrap items-center gap-x-2 text-xs">
              <Link className="underline" to={globLink(boardId, s.globId)}>
                <span className="font-mono">{s.globId}</span> {s.title}
              </Link>
              <span className="text-muted-foreground">{s.reason}</span>
              <Button size="sm" variant="outline" onClick={() => setAttaching([s.globId])}>
                Attach
              </Button>
            </li>
          ))}
        </ul>
      )}
      {attached.length > 0 && (
        <p className="flex flex-wrap gap-1 text-xs">
          <span className="text-muted-foreground">On:</span>
          {attached.map((a) => (
            <Link
              key={a.globId}
              className="rounded-full border px-2 underline"
              to={globLink(boardId, a.globId)}
            >
              {a.globId}
            </Link>
          ))}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {item.status !== 'discarded' && (
          <Button size="sm" onClick={() => setAttaching(suggestions.map((s) => s.globId))}>
            Attach to…
          </Button>
        )}
        {item.status === 'new' && (
          <Button
            size="sm"
            variant="outline"
            disabled={settle.isPending}
            onClick={() => settle.mutate('keep')}
          >
            Keep
          </Button>
        )}
        {item.status !== 'attached' &&
          (confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={settle.isPending}
                onClick={() => settle.mutate('discard')}
              >
                Discard it
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
                Keep it here
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
              Discard
            </Button>
          ))}
        <Button size="sm" variant="ghost" onClick={() => setShowText((v) => !v)}>
          {showText ? 'Hide text' : 'Show text'}
        </Button>
      </div>
      {showText && (
        <div className="max-h-96 overflow-auto rounded border bg-background p-2 text-xs whitespace-pre-wrap break-words">
          {detail.isError ? 'Could not load the text.' : (detail.data?.text ?? 'Loading…')}
        </div>
      )}
      {attaching !== null && (
        <AttachDialog
          boardId={boardId}
          item={item}
          globs={globs}
          initial={attaching}
          open
          onOpenChange={(o) => !o && setAttaching(null)}
          onDone={onChanged}
        />
      )}
    </li>
  );
};

/** The board's inbox (spec, Inbox and ingest): pasted notes, threads and documents, each with a summary and suggested globs, to attach, keep or discard. */
export const InboxPage = () => {
  const boardId = Number(useParams().boardId);
  const client = useQueryClient();
  const live = useLiveInbox(boardId);
  const { headerActions } = useOutletContext<BoardShellContext>();
  const [params] = useSearchParams();
  const target = Number(params.get('item'));
  const [pasting, setPasting] = useState(false);
  const [onlyNew, setOnlyNew] = useState(false);
  const items = useQuery({
    queryKey: inboxKey(boardId),
    queryFn: () => api.inbox(boardId),
    refetchInterval: (q) => (pendingCount(q.state.data ?? []) > 0 ? POLL_MS : false),
  });
  const globs = useQuery({ queryKey: globsKey(boardId), queryFn: () => api.globs(boardId) });
  const changed = () => {
    void client.invalidateQueries({ queryKey: inboxKey(boardId) });
    void client.invalidateQueries({ queryKey: globsKey(boardId) });
  };
  const shown = visibleItems(items.data ?? [], onlyNew);

  return (
    <div className="mx-auto grid max-w-3xl gap-3 px-5 py-4" data-testid="inbox" data-live={live}>
      <h1 className="sr-only">Inbox</h1>
      {headerActions !== null &&
        createPortal(
          <Button size="sm" className="text-sm" onClick={() => setPasting(true)}>
            <Plus className="h-4 w-4" /> Paste into inbox
          </Button>,
          headerActions,
        )}
      <PasteIntoInbox
        boardId={boardId}
        open={pasting}
        onOpenChange={setPasting}
        onAdded={changed}
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
        Only items that are new
      </label>
      {items.isError ? (
        <p className="text-sm text-red">Could not load the inbox.</p>
      ) : items.data === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing here. Paste meeting notes, a thread or a document to file it against your globs.
        </p>
      ) : (
        <ul className="grid gap-3">
          {shown.map((item) => (
            <Card
              key={item.id}
              boardId={boardId}
              item={item}
              globs={globs.data ?? []}
              highlighted={item.id === target}
              onChanged={changed}
            />
          ))}
        </ul>
      )}
    </div>
  );
};
